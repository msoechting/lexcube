# Lexcube - Interactive 3D Data Cube Visualization
# Copyright (C) 2022 Maximilian Söchting <maximilian.soechting@uni-leipzig.de>
# 
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 3 of the License, or
# (at your option) any later version.
# 
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
# 
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

from __future__ import annotations

import enum
import gc
from hashlib import sha512
import json
import math
import os
import shutil
import struct
import threading
import time
import bottleneck
import re
import warnings
import itertools
import copy
from datetime import datetime
from itertools import groupby
import multiprocessing
from operator import itemgetter
from typing import Iterable, List, Callable
from copy import deepcopy
# from cProfile import Profile
# from pstats import SortKey, Stats

import cftime
import cv2
import fsspec
import numcodecs
import numpy as np
import psutil
import xarray as xr
from dask.cache import Cache
from typing import Union

UNCOMPRESSED_SUFFIX = "_uncompressed"
ANOMALY_PARAMETER_ID_SUFFIX = "_lxc_anomaly"
RGB_PARAMETER_ID_SUFFIX = "_lxc_rgb"

DEFAULT_PRE_GENERATION_SPARSITY = 8
DEFAULT_PRE_GENERATION_THREADS = 4
NAN_TILE_MAGIC_NUMBER = -1
LOSSLESS_TILE_MAGIC_NUMBER = -2
API_VERSION = 6
TILE_VERSION = 2
TILE_VERSION_3D = TILE_VERSION | 128 # set 8th bit to indicate 3D tile 
DEFAULT_TILE_SIZE_2D = 256
DEFAULT_TILE_SIZE_3D = 256

TILE_VERSION_MASK = 255 # mask to get base tile version (lower 8 bits)

TILE_VERSION_FLAG_FLOAT32 = 256 # set 9th bit to indicate float32 tile data
TILE_VERSION_FLAG_FLOAT64 = 512 # set 10th bit to indicate float64 tile data
TILE_VERSION_FLAG_RGB_UINT8 = 1024 # set 11th bit to indicate uint8 RGB tile data

NON_EXTREME_QUANTILE_INDEX = 100 # assumed to be  =extreme_detection_result.high_quantile_first_index - 1

NAN_FACTOR_MASK_NAN_VALUE = 0
NAN_FACTOR_MASK_VALID_VALUE = 255

RGB_NAN_ALPHA_VALUE = 0

TILE_FORMAT_MAGIC_BYTES = "lexc".encode("utf-8") # 6c 65 78 63, magic bytes to recognize lexcube tiles

TILE_FORMAT_ZFP = "zfp"
TILE_3D_FORMAT_VLQ = "vlq"
TILE_FORMAT_BLOSC_LZ4 = "blosc_lz4"
TILE_FORMAT_2D = "2D"

TILE_3D_FORMAT_TO_FILE_EXTENSION = {
    TILE_FORMAT_ZFP: "",
    TILE_3D_FORMAT_VLQ: ".vlq",
    TILE_FORMAT_BLOSC_LZ4: ".blosc_lz4",
}

LONGITUDE_DIMENSION_NAMES = ["longitude","lon"]
LATITUDE_DIMENSION_NAMES = ["latitude","lat"]
GEOSPATIAL_X_DIMENSION_NAMES = ["x"] + LONGITUDE_DIMENSION_NAMES
GEOSPATIAL_Y_DIMENSION_NAMES = ["y"] + LATITUDE_DIMENSION_NAMES
TIME_DIMENSION_NAMES = ["time"]
BAND_DIMENSION_NAMES = ["band", "bands", "channel", "channels"]

DEFAULT_DIMENSIONS = ["Z", "Y", "X"]
DEFAULT_DIMENSIONS_4D = ["Z", "Y", "X", "band"]
DEFAULT_VARIABLE_NAME = "default_var"

DEFAULT_LOG_PATH = "logs"

class DataSourceProxy:
    def __init__(self, data_source: Union[xr.DataArray, np.ndarray]) -> None:
        self.data_source = data_source
        self.cache_chunks = type(data_source) == xr.DataArray and data_source.chunks and len(data_source.chunks) > 0
        self.shape = self.data_source.shape
        if self.cache_chunks:
            self.x_chunk_indices = np.append(np.array([0]), np.cumsum(data_source.chunks[2]))
            self.y_chunk_indices = np.append(np.array([0]), np.cumsum(data_source.chunks[1]))
            self.z_chunk_indices = np.append(np.array([0]), np.cumsum(data_source.chunks[0]))
            self.x_chunks = self.data_source.chunks[2]
            self.y_chunks = self.data_source.chunks[1]
            self.z_chunks = self.data_source.chunks[0]
        self.chunk_cache = {}

    def find_affected_chunks(self, x: slice, y: slice, z: slice):
        x_chunk_start = np.searchsorted(self.x_chunk_indices, x.start, side="right") - 1
        x_chunk_end = np.searchsorted(self.x_chunk_indices, x.stop - 1, side="right") - 1
        y_chunk_start = np.searchsorted(self.y_chunk_indices, y.start, side="right") - 1
        y_chunk_end = np.searchsorted(self.y_chunk_indices, y.stop - 1, side="right") - 1
        z_chunk_start = np.searchsorted(self.z_chunk_indices, z.start, side="right") - 1
        z_chunk_end = np.searchsorted(self.z_chunk_indices, z.stop - 1, side="right") - 1
        return [(z, y, x) for z in range(z_chunk_start, z_chunk_end + 1) for y in range(y_chunk_start, y_chunk_end + 1) for x in range(x_chunk_start, x_chunk_end + 1)]
    
    def get_chunk_slices(self, chunk_ix: int, chunk_iy: int, chunk_iz: int):
        return (slice(self.z_chunk_indices[chunk_iz], self.z_chunk_indices[chunk_iz + 1]),
                slice(self.y_chunk_indices[chunk_iy], self.y_chunk_indices[chunk_iy + 1]),
                slice(self.x_chunk_indices[chunk_ix], self.x_chunk_indices[chunk_ix + 1]))

    def get_chunk_slices_for_request(self, chunk_ix: int, chunk_iy: int, chunk_iz: int, x_request_slice: slice, y_request_slice: slice, z_request_slice: slice):
        chunk_slices = self.get_chunk_slices(chunk_ix, chunk_iy, chunk_iz)
        lower_x = max(x_request_slice.start - chunk_slices[2].start, 0)
        upper_x = min(x_request_slice.stop - chunk_slices[2].start, chunk_slices[2].stop - chunk_slices[2].start)
        lower_y = max(y_request_slice.start - chunk_slices[1].start, 0)
        upper_y = min(y_request_slice.stop - chunk_slices[1].start, chunk_slices[1].stop - chunk_slices[1].start)
        lower_z = max(z_request_slice.start - chunk_slices[0].start, 0)
        upper_z = min(z_request_slice.stop - chunk_slices[0].start, chunk_slices[0].stop - chunk_slices[0].start)
        chunk_copy_source_slices = (slice(lower_z, upper_z), slice(lower_y, upper_y), slice(lower_x, upper_x))

        request_copy_target_slice_lower_x = chunk_slices[2].start - x_request_slice.start + lower_x
        request_copy_target_slice_upper_x = request_copy_target_slice_lower_x + upper_x - lower_x
        request_copy_target_slice_lower_y = chunk_slices[1].start - y_request_slice.start + lower_y
        request_copy_target_slice_upper_y = request_copy_target_slice_lower_y + upper_y - lower_y
        request_copy_target_slice_lower_z = chunk_slices[0].start - z_request_slice.start + lower_z
        request_copy_target_slice_upper_z = request_copy_target_slice_lower_z + upper_z - lower_z
        request_copy_target_slices = (slice(request_copy_target_slice_lower_z, request_copy_target_slice_upper_z), slice(request_copy_target_slice_lower_y, request_copy_target_slice_upper_y), slice(request_copy_target_slice_lower_x, request_copy_target_slice_upper_x))
        return (chunk_copy_source_slices, request_copy_target_slices)

    def get_chunk(self, iz: int, iy: int, ix: int):
        chunk_key = (iz, iy, ix)
        if chunk_key not in self.chunk_cache:
            slices = self.get_chunk_slices(ix, iy, iz)
            self.chunk_cache[chunk_key] = self.data_source[slices].values
        return self.chunk_cache[chunk_key]

    def validate_slice(self, s: Union[slice, int], dimension: int):
        if type(s) == int:
            s = slice(s, s + 1)
        return slice(max(s.start, 0), min(s.stop, self.shape[dimension]))

    def __getitem__(self, arg):
        if not self.cache_chunks or type(arg) != tuple or len(arg) != 3:
            return self.data_source.__getitem__(arg)
        (z_request_slice, y_request_slice, x_request_slice) = [self.validate_slice(s, i) for i, s in enumerate(arg)]
        chunks = self.find_affected_chunks(x_request_slice, y_request_slice, z_request_slice)
        output = np.ndarray((z_request_slice.stop - z_request_slice.start, y_request_slice.stop - y_request_slice.start, x_request_slice.stop - x_request_slice.start), dtype=self.data_source.dtype)
        for (iz, iy, ix) in chunks:
            c = self.get_chunk(iz, iy, ix)
            (chunk_copy_source_slices, request_copy_target_slices) = self.get_chunk_slices_for_request(ix, iy, iz, x_request_slice, y_request_slice, z_request_slice)
            np.copyto(output[request_copy_target_slices], c[chunk_copy_source_slices])
        return np.squeeze(output)
    
    @property
    def dtype(self):
        return self.data_source.dtype


# from: https://stackoverflow.com/a/2135920
def split_list_into_equal_parts(l: list, parts: int):
    k, m = divmod(len(l), parts)
    return ([l[i*k+min(i, m):(i+1)*k+min(i+1, m)]] for i in range(parts))

def log_line(f, s: str = "", stdout_too: bool = True):
    line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} - {s}"
    if stdout_too:
        print(line)
    f.write(f"{line}\n")
    f.flush()

def get_current_memory_usage(s: str = ""):
    used_mb = round(psutil.Process(os.getpid()).memory_info().rss / 1024 ** 2, 2)
    available_mb = round(psutil.virtual_memory().available / 1024 ** 2, 2)
    return f"° Currently used memory: {f'{round(used_mb / 1024, 2)} GB'} - Available: {f'{round(available_mb / 1024, 2)} GB'} {f'[{s}]'}"


class TileCompressor:
    def __init__(self, current_output_tile_format: str) -> None:
        self.current_output_tile_format = current_output_tile_format # set for widget mode to lossless, during pregeneration 
        self.tile_data_compressor_zfp = ZfpCompressor()
        self.tile_data_compressor_blosc_lz4_lossless = numcodecs.blosc.Blosc()
        self.nan_mask_compressor = numcodecs.lz4.LZ4(5)

    def set_tolerance(self, default_compression_tolerance: float, anomaly_compression_tolerance: float):
        self.default_compression_tolerance = default_compression_tolerance
        self.anomaly_compression_tolerance = anomaly_compression_tolerance

    def compress_nan_mask(self, nan_mask: bytes) -> bytes:
        return self.nan_mask_compressor.encode(nan_mask)
    
    def decompress_nan_mask(self, data: bytes) -> bytes:
        return self.nan_mask_compressor.decode(data)

    def is_currently_encoding_losslessly(self) -> bool:
        return self.current_output_tile_format == TILE_FORMAT_BLOSC_LZ4
    
    def get_tile_data_compressor(self, use_lossless_override: Union[bool, None] = None):
        if self.current_output_tile_format == TILE_FORMAT_BLOSC_LZ4 or use_lossless_override == True:
            return self.tile_data_compressor_blosc_lz4_lossless
        elif self.current_output_tile_format == TILE_FORMAT_ZFP:
            return self.tile_data_compressor_zfp
        elif self.current_output_tile_format == TILE_3D_FORMAT_VLQ:
            return self.tile_data_compressor_vlq
        else:
            raise ValueError(f"Unsupported tile format: {self.current_output_tile_format}")
    
    def compress_tile_data(self, tile_coords: tuple, tile_data: np.ndarray, is_anomaly_tile: bool = False) -> bytes:
        compressor = self.get_tile_data_compressor()
        if self.current_output_tile_format == TILE_FORMAT_ZFP:
            self.tile_data_compressor_zfp.tolerance = self.anomaly_compression_tolerance if is_anomaly_tile else self.default_compression_tolerance
        if self.current_output_tile_format == TILE_3D_FORMAT_VLQ:
            self.tile_data_compressor_vlq.rmse_threshold = self.anomaly_compression_tolerance if is_anomaly_tile else self.default_compression_tolerance
            self.tile_data_compressor_vlq.absolute_error_threshold = self.anomaly_compression_tolerance if is_anomaly_tile else self.default_compression_tolerance
        result = compressor.encode(tile_data)
        if self.current_output_tile_format == TILE_3D_FORMAT_VLQ:
            self.tile_data_compressor_vlq.persist_last_payload_stats("-".join(map(str, tile_coords)))
        return result
        
    def decompress_tile_data(self, tile_data: bytes, use_lossless_override: Union[bool, None] = None) -> np.ndarray:
        return self.get_tile_data_compressor(use_lossless_override).decode(tile_data)

class PerformanceTimer:    
    def __init__(self) -> None:
        self.time_elapsed_since_last_call = time.perf_counter_ns()

    def reset_time_elapsed_since_last_call(self):
        self.time_elapsed_since_last_call = time.perf_counter()

    def print_time_elapsed_since_last_call(self, s: str = ""):
        print(f"........................ [{s}] Time elapsed since last call: {round(time.perf_counter_ns() - self.time_elapsed_since_last_call, 2)} ns")
        self.time_elapsed_since_last_call = time.perf_counter_ns()

class Dimension(enum.Enum):
    Z = 0
    Y = 1
    X = 2

dimension_mapping = {
    "by_z": Dimension.Z,
    "by_y": Dimension.Y,
    "by_x": Dimension.X
}


def downscale_quantile_indices_signed_max_relative(A: np.ndarray) -> np.ndarray:
    if A.ndim != 3:
        raise ValueError(f"Expected 3D array (Z,Y,X), got shape {A.shape}")
    z, y, x = A.shape
    if (z % 2) or (y % 2) or (x % 2):
        raise ValueError(f"All dimensions must be divisible by 2, got {A.shape}")

    dev = A.astype(np.int16) - int(NON_EXTREME_QUANTILE_INDEX)
    blocked = dev.reshape(z // 2, 2, y // 2, 2, x // 2, 2)
    flat = blocked.reshape(z // 2, y // 2, x // 2, 8)

    # pick signed dev with largest absolute value per block
    idx = np.argmax(np.abs(flat), axis=3)
    picked = np.take_along_axis(flat, idx[..., None], axis=3)[..., 0]

    return (picked + int(NON_EXTREME_QUANTILE_INDEX)).astype(np.uint8)

def downscale(a: np.ndarray, factor=0.5):
    return downscale_fast_2d(a, factor) if len(a.shape) == 2 else downscale_3d_nanmean(a, factor)

def downscale_fast_2d(arr: np.ndarray, factor=0.5):
    return cv2.resize(arr, None, fx=factor, fy=factor, interpolation=cv2.INTER_LINEAR)

# Will propagate NaN values
# def downscale_slow_3d(arr: np.ndarray, factor=0.5):
#     from scipy.ndimage import zoom
#     return zoom(arr, (factor, factor, factor), order=1, mode="grid-constant", grid_mode=True)

# Will ignore NaN values and NOT propagate them per 2x2x2 block
def downscale_3d_nanmean(arr: np.ndarray, factor=0.5):
    from skimage.measure import block_reduce

    if factor <= 0:
        raise ValueError("factor must be a positive value.")
    block_factor = int(1 / factor)
    
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Mean of empty slice.*",
            category=RuntimeWarning,
        )
        return block_reduce(
            arr, 
            block_size=(block_factor, block_factor, block_factor), 
            func=np.nanmean
        )

# Applies nanmean with intermediate ceil() call to keep positive values over high LoDs (which would otherwise be rounded down to zero)
def downscale_nan_factor_mask(arr: np.ndarray, factor=0.5):
    from skimage.measure import block_reduce
    if factor <= 0:
        raise ValueError("factor must be a positive value.")
    block_factor = int(1 / factor)

    def nanmean_ceiled(blocked, axis):
        m = np.nanmean(blocked, axis=axis, dtype=np.float64)
        return np.ceil(m).astype(np.uint8)

    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Mean of empty slice.*",
            category=RuntimeWarning,
        )
        return block_reduce(
            arr,
            block_size=(block_factor, block_factor, block_factor),
            func=nanmean_ceiled,
        )


def downscale_fast_3d(arr: np.ndarray, factor=0.5): # but this probably propogates NaN values, so it sucks
    if factor != 0.5:
        print("Shrinking 3D array by non-2-divisor is not supported")
        return
    resized_slices = [cv2.resize(s, None, fx=factor, fy=factor, interpolation=cv2.INTER_LINEAR) for s in arr] # bilinear filtering for each plane
    target = np.zeros(tuple(int(x/2) for x in arr.shape), dtype=arr.dtype)
    for arr in range(int(arr.shape[0] / 2)):
        target[arr] = (resized_slices[arr*2]+resized_slices[arr*2+1])/2 # merge adjacent planes, trilinear filtering
    return target

def interpolate_nans_1d(array):
    not_nan = np.logical_not(np.isnan(array))
    indices = np.arange(len(array))
    return np.interp(indices, indices[not_nan], array[not_nan])

def interpolate_and_smooth_nans_1d_padded(array, kernel_size):
    not_nan = np.logical_not(np.isnan(array))
    if not np.any(not_nan):
        return array
    kernel_radius = int((kernel_size - 1) / 2)
    not_nan_indices = np.where(not_nan)
    first_non_nan_index = not_nan_indices[0][0]
    last_non_nan_index = not_nan_indices[0][-1]
    begin_padding_index = max(first_non_nan_index, kernel_radius)
    end_padding_index = min(last_non_nan_index, len(array) - kernel_radius)
    before = array[end_padding_index:]
    after = array[:begin_padding_index + 1]
    result = np.concatenate((before, array, after))
    result = interpolate_nans_1d(result)
    result = apply_mean_filter(result, kernel_size)
    return result[len(before)+kernel_radius:-len(after)+kernel_radius]

def apply_mean_filter(array, kernel_size):
    return bottleneck.move_mean(array, window=kernel_size, min_count=1)

def interpolate_nans_and_smooth(input_list: list):
    for i, (iy, ix, time_series, sparse_doy_keys) in enumerate(input_list):
        kernel_size = 17 # considers 4.6% of the year
        t = np.full(366, np.nan)
        keys = np.fromiter(sparse_doy_keys, np.uint64) - 1
        t[keys] = time_series
        interpolated = interpolate_and_smooth_nans_1d_padded(t, kernel_size)
        input_list[i] = (iy, ix, interpolated[keys])
    return input_list

def sample_data_array_2d(data, sample_factor):
    s = data[::sample_factor,::sample_factor]
    return np.stack([s[i] for i in range(len(s))]) 

def calculate_max_lod(tile_size: int, dims: list[int]):
    if tile_size <= 0 or len(dims) == 0 or min(dims) <= 0 or max(dims) <= 0:
        return 0
    desired_max_lod = math.ceil(-math.log2(tile_size / max(dims)))
    largest_lod_possible_from_dims = math.floor(math.log2(min(dims)))
    largest_lod_possible_from_tile_size = math.floor(math.log2(tile_size))
    return max(0, min(desired_max_lod, largest_lod_possible_from_dims, largest_lod_possible_from_tile_size))

def patch_data(data: np.ndarray, dataset_id: str, parameter: str, dataset_config: DatasetConfig = None) -> np.ndarray:
    if len(data.shape) == 4: # RGB data does not need patching
        return data
    if dataset_id == "esdc-2.1.1-high-res" and parameter in ["sensible_heat", "terrestrial_ecosystem_respiration", "net_radiation", "net_ecosystem_exchange", "latent_energy", "gross_primary_productivity"]:
        data = np.where(data==-9999, np.nan, data) # Replace netcdf -9999(=NaN) values
    if parameter == "snow_water_equivalent":
        data = np.where(data==-1, np.nan, data) # -1 = Oceans = NaN
        data = np.where(data==-2, 0, data) # -2 = mountains or something...
    return data

def parse_parameter_dimensions_from_dataset(ds: Union[xr.DataArray, xr.Dataset, np.ndarray]):
    if type(ds) == np.ndarray:
        dims_3d = DEFAULT_DIMENSIONS if len(ds.shape) == 3 else None
        dims_4d = DEFAULT_DIMENSIONS if len(ds.shape) == 4 else None
    elif type(ds) == xr.DataArray:
        dims_3d = ds.dims if len(ds.dims) == 3 else None
        dims_4d = ds.dims if len(ds.dims) == 4 else None
    else:
        parameters_3d = [(p, ds[p].dims, ds[p].shape) for p in ds.data_vars if len(ds[p].dims) == 3]
        parameters_4d = [(p, ds[p].dims, ds[p].shape) for p in ds.data_vars if len(ds[p].dims) == 4]
        if len(parameters_3d) > 0:
            if not all(p[1] == parameters_3d[0][1] for p in parameters_3d):
                raise ValueError(f"Mixed dimension orders for 3d parameters in dataset: {', '.join(p[0] for p in parameters_3d)} ({', '.join(p[1] for p in parameters_3d)})")
        if len(parameters_4d) > 0:
            if not all(p[1] == parameters_4d[0][1] for p in parameters_4d):
                raise ValueError(f"Mixed dimension orders for 4d parameters in dataset: {', '.join(p[0] for p in parameters_4d)} ({', '.join(p[1] for p in parameters_4d)})")
        dims_3d, dims_4d = parameters_3d[0][1] if len(parameters_3d) > 0 else None, parameters_4d[0][1] if len(parameters_4d) > 0 else None
    return (dims_4d or dims_3d), dims_3d, dims_4d

def patch_dataset(ds: Union[xr.DataArray, xr.Dataset, np.ndarray], skip_print: bool = False):
    if type(ds) == np.ndarray:
        return ds
    
    print_if_needed = print if not skip_print else lambda *args, **kwargs: None
    
    dims_any, _, dims_4d = parse_parameter_dimensions_from_dataset(ds)
    
    if dims_4d: 
        target_dimension_order = [TIME_DIMENSION_NAMES, GEOSPATIAL_Y_DIMENSION_NAMES, GEOSPATIAL_X_DIMENSION_NAMES, BAND_DIMENSION_NAMES]
        dimension_indices = [next((i for i, d in enumerate(dims_4d) if d in names), -1) for names in target_dimension_order]

        if any(i == -1 for i in dimension_indices):
            raise ValueError(f"Dataset has 4 dimensions {dims_4d}, but does not match required dimensions  ({target_dimension_order})")
        
        if not dimension_indices == list(range(4)):
            ds = ds.transpose(*[dims_4d[i] for i in dimension_indices])
            _, _, new_dims_4d = parse_parameter_dimensions_from_dataset(ds)
            print_if_needed(f"            * Transposed 4-dimension dataset from {dims_4d} to {new_dims_4d}")
        print_if_needed(f"        > Correctly parsed 4-dimension parameters with dims {dims_4d}")

        dims_any, _, dims_4d = parse_parameter_dimensions_from_dataset(ds)

    # time-DOY data set detection
    if "time" in ds.dims and np.issubdtype(ds["time"].dtype, np.integer) and ds["time"].min() >= 0 and ds["time"].max() <= 365:
        possible_years = re.findall(r'(\d{4})', ds.encoding["source"])
        guessed_year = 1900
        if len(possible_years) > 0:
            guessed_year = possible_years[-1]
            print_if_needed(f"        > Detected time-DOY dataset with year {guessed_year} (from file name)")
        else:
            print_if_needed(f"        > Detected time-DOY dataset, but could not find year in source file name, assigning {guessed_year} as default")
        ds = ds.assign_coords(time=[datetime.strptime(f"{guessed_year}-{doy+1:03}", "%Y-%j") for doy in ds["time"]])
        print_if_needed(f"            * New first time value: {ds['time'].values[0]} - last: {ds['time'].values[-1]}")

    if dims_any[1] in LONGITUDE_DIMENSION_NAMES and dims_any[2] in LATITUDE_DIMENSION_NAMES:
        dims_any[1], dims_any[2] = dims_any[2], dims_any[1]
        ds = ds.transpose(*dims_any)
        print_if_needed(f"        > Transposed dataset from (..., lon, LAT) to (..., LAT, lon)")
        dims_any, _, dims_4d = parse_parameter_dimensions_from_dataset(ds)

    expected_dimension_increasing = [True, False, True] # lat is expected decreasing
    expected_names = [TIME_DIMENSION_NAMES, LATITUDE_DIMENSION_NAMES, LONGITUDE_DIMENSION_NAMES]
    for d in range(3):
        if dims_any[d] in expected_names[d]:
            values = ds[dims_any[d]].values
            if len(values) > 1 and (values[0] < values[1]) != expected_dimension_increasing[d]:
                ds = ds.isel({ dims_any[d]: slice(None, None, -1) })
                print_if_needed(f"        > Dataset has {dims_any[d]} dimension in {'ascending' if expected_dimension_increasing[d] else 'descending'} order, flipping it to {'ascending' if expected_dimension_increasing[d] else 'descending'} order")

    return ds

def open_dataset(config: ServerConfig, path: str, skip_print: bool = False) -> xr.Dataset:
    aws_s3_hosted = path.startswith("s3://")
    http_hosted = path.startswith("http://")
    remote_hosted = aws_s3_hosted or http_hosted
    file_extension = path.split(".")[-1]
    protocol = path.split("://")[0]
    if not skip_print:
        print(f"        > Opening {f'{protocol}-hosted' if remote_hosted else 'locally saved'} dataset ({path})")
    protocol_map = {
        "s3": fsspec.get_mapper(path, anon=True)
    }
    if path.count("*") > 0 and path.endswith(".nc"):
        print("        > Opening globbed multiple NC files [EXPERIMENTAL]")
        print("              Will merge first variable of every file into single variable")
        print("              Assuming 1 time step per file")
        def preprocess(ds):
            current_var_name = list(ds.data_vars)[0]
            target_var_name = "merged_nc_variable"
            ds = ds.rename_vars({ current_var_name: target_var_name})
            return ds

        ds = xr.open_mfdataset(os.path.join(config.base_dir, path), engine="netcdf4", combine="nested", concat_dim="time", preprocess=preprocess, parallel=True, chunks={ "time": 1 })
        ds = patch_dataset(ds, skip_print)
        return ds
    store = (protocol_map.get(protocol) or fsspec.get_mapper(path)) if remote_hosted else os.path.join(config.base_dir, path)
    engines = {
        "zarr": "zarr",
        "nc": "netcdf4"
    }
    ds = xr.open_dataset(store, engine=engines[file_extension], chunks={})
    ds = patch_dataset(ds, skip_print)
    return ds 

class CompositeRgbParameter:
    def __init__(self, rgb_config: dict) -> None:
        self.name = str(rgb_config["name"]) + RGB_PARAMETER_ID_SUFFIX
        self.long_name = str(rgb_config["long_name"])
        self.data_var = str(rgb_config["data_var"] if "data_var" in rgb_config else "")
        self.bands = [str(band) for band in rgb_config.get("bands", [])]
        self.data_vars = [str(band) for band in rgb_config.get("data_vars", [])]
        self.meta_data = {}
        self.use_bands_of_single_data_var = False
        
        self.rgb_scale_lower_bounds = np.full((3,), np.nan)
        self.rgb_scale_upper_bounds = np.full((3,), np.nan)
        parsed_rgb_scale = rgb_config.get("rgb_scale", np.nan)

        # parsed_rgb_scale is either float, list of three floats, or list of three lists of two floats
        if type(parsed_rgb_scale) == float or type(parsed_rgb_scale) == int:
            self.rgb_scale_lower_bounds[:] = 0.0
            self.rgb_scale_upper_bounds[:] = float(parsed_rgb_scale)
        elif type(parsed_rgb_scale) == list and len(parsed_rgb_scale) == 3 and all(type(v) in [float, int] for v in parsed_rgb_scale):
            self.rgb_scale_lower_bounds[:] = 0.0
            self.rgb_scale_upper_bounds[:] = [float(v) for v in parsed_rgb_scale]
        elif type(parsed_rgb_scale) == list and len(parsed_rgb_scale) == 3 and all(type(v) == list and len(v) == 2 and all(type(x) in [float, int] for x in v) for v in parsed_rgb_scale):
            self.rgb_scale_lower_bounds[:] = [float(v[0]) for v in parsed_rgb_scale]
            self.rgb_scale_upper_bounds[:] = [float(v[1]) for v in parsed_rgb_scale]
        else:
            raise ValueError(f"Invalid 'rgb_scale' value for RGB parameter '{self.long_name}': must be float, list of three floats, or list of three lists of two floats (found {parsed_rgb_scale})")

        if len(self.bands) == 3 and len(self.data_var) > 0:
            self.use_bands_of_single_data_var = True
            print(f"Valid RGB parameter '{self.long_name}': using three bands {len(self.bands)} in data_var '{self.data_var}' with scale {self.rgb_scale_lower_bounds} - {self.rgb_scale_upper_bounds}")
        elif len(self.bands) == 0 and len(self.data_vars) == 3:
            print(f"Valid RGB parameter '{self.long_name}': using three data_vars {len(self.data_vars)} with scale {self.rgb_scale_lower_bounds} - {self.rgb_scale_upper_bounds}")
        else:
            raise ValueError(f"Invalid RGB parameter '{self.long_name}': either 'bands' or 'data_vars' must contain exactly three entries (found {len(self.bands)} bands with data_var {self.data_var} and {len(self.data_vars)} data_vars)")
    
    def get_parameter_data(self, dataset: xr.Dataset) -> xr.DataArray:
        if self.use_bands_of_single_data_var:
            data_array = dataset[self.data_var]
            band_dimension_name = next((d for d in data_array.dims if d in BAND_DIMENSION_NAMES), None)
            data_array = data_array.sel({ band_dimension_name: self.bands })
            print(f"        > Retrieved RGB parameter '{self.long_name}' from data_var '{self.data_var}' with bands {self.bands}")
            return data_array
        else:
            missing_data_vars = [dv for dv in self.data_vars if dv not in dataset.data_vars]
            if len(missing_data_vars) > 0:
                raise ValueError(f"RGB parameter '{self.long_name}' references data_vars {missing_data_vars} which are not present in the dataset")
            data_arrays = [dataset[dv] for dv in self.data_vars]
            for (i, da) in enumerate(data_arrays):
                if len(da.dims) != 3:
                    raise ValueError(f"RGB parameter '{self.long_name}' references data_var '{da.name}' which does not have three dimensions (found {len(da.dims)} dimensions)")
            first_dims = data_arrays[0].dims
            if not all(da.dims == first_dims for da in data_arrays):
                raise ValueError(f"RGB parameter '{self.long_name}' references data_vars with mixed dimension orders: {', '.join(da.name + ' (' + str(da.dims) + ')' for da in data_arrays)}")
            band_dimension_name = BAND_DIMENSION_NAMES[0]
            for (i, da) in enumerate(data_arrays):
                v = f"{i+1}-{da.name}"
                data_arrays[i] = da.expand_dims({ band_dimension_name: [v]}, axis=-1)#.assign_coords({ band_dimension_name: v })
            data_array = xr.concat(data_arrays, dim=band_dimension_name)
            return data_array


    def set_metadata(self, dataset_metadata: DatasetMetadata, first_band_discovered_metadata: DiscoveredParameterMetadata) -> dict:
        data_var_dataset_metadata = dataset_metadata.dataset_dict["data_vars"][self.data_var if self.use_bands_of_single_data_var else self.data_vars[0]]
        
        merged_metadata = data_var_dataset_metadata.copy()
        for (key, val) in first_band_discovered_metadata.to_dict().items():
            merged_metadata[key] = val

        if not np.isfinite(self.rgb_scale_upper_bounds[0]):
            if merged_metadata["minimum_value"] < 0:
                raise ValueError(f"Invalid RGB parameter '{self.long_name}': has minimum {merged_metadata['minimum_value']} (expected >= 0)")
            if merged_metadata["maximum_value"] > 255:
                raise ValueError(f"Invalid RGB parameter '{self.long_name}': has maximum {merged_metadata['maximum_value']} (expected <= 255)")
            self.rgb_scale_upper_bounds[:] = 255.0 if merged_metadata["maximum_value"] > 1 else 1.0
        
        merged_metadata["name"] = self.name
        if merged_metadata["attrs"] is None:
            merged_metadata["attrs"] = {}
        merged_metadata["attrs"]["rgb_source_bands"] = self.bands
        merged_metadata["attrs"]["rgb_scale_lower_bounds"] = self.rgb_scale_lower_bounds.tolist()
        merged_metadata["attrs"]["rgb_scale_upper_bounds"] = self.rgb_scale_upper_bounds.tolist()
        merged_metadata["attrs"]["long_name"] = self.long_name
        merged_metadata["attrs"]["description"] = f"Composite RGB parameter with bands {self.bands} from parameter '{self.data_var}', visualized with scale {self.rgb_scale_lower_bounds} - {self.rgb_scale_upper_bounds}"
        print(f"        > Setting metadata for RGB parameter '{self.long_name}' with bands {self.bands} and scale {self.rgb_scale_lower_bounds} - {self.rgb_scale_upper_bounds}")
        print(f"final metadata: {merged_metadata}")
        
        self.meta_data = merged_metadata

class DatasetConfig:
    def __init__(self, dataset_config: dict) -> None:
        self.id = str(dataset_config["id"])
        self.short_name = str(dataset_config["shortName"])
        self.dataset_path = str(dataset_config["datasetPath"])
        self.ignored_parameters: list[str] = list(dataset_config.get("ignoredParameters") or [])
        self.only_parameters: list[str] = list(dataset_config.get("onlyParameters") or [])
        self.pre_generation_sparsity_2d_tiles = int(dataset_config.get("preGenerationSparsity") or dataset_config.get("preGenerationSparsity2dTiles") or DEFAULT_PRE_GENERATION_SPARSITY) 
        self.force_tile_generation = bool(dataset_config.get("forceTileGeneration") or False) 
        self.max_lod_2d = int(dataset_config.get("overrideMaxLod") or dataset_config.get("overrideMaxLod2d") or -1)
        self.max_lod_3d = int(dataset_config.get("overrideMaxLod3d") or -1)
        self.enable_2d_tiles = bool(dataset_config.get("enable2dTiles") if "enable2dTiles" in dataset_config else True)
        self.enable_3d_tiles = bool(dataset_config.get("enable3dTiles") or dataset_config.get("enable3DTiles") or False)
        self.enable_3d_extremes = bool(dataset_config.get("enable3dExtremes") or False)
        self.target_3d_tile_formats = list(dataset_config.get("target3dTileFormats") or [TILE_FORMAT_ZFP])
        self.calculate_anomalies = bool(dataset_config.get("calculateYearlyAnomalies") or dataset_config.get("calculateAnomalies") or False)
        self.use_offline_metadata = bool(dataset_config.get("useOfflineMetadata") or False) 
        self.min_max_values_approximate_only = bool(dataset_config.get("approximateMinMaxValues") or True)
        self.allow_data_downloads = bool(dataset_config.get("allowDataDownloads") or False)
        self.rgb_parameters: list[CompositeRgbParameter] = [CompositeRgbParameter(rgb) for rgb in dataset_config.get("rgbParameters", [])]
        self.allow_float64_in_compressed_tiles = bool(dataset_config.get("allowFloat64") or False)


def get_dimension_type(dimension_name: str):
    if dimension_name in LONGITUDE_DIMENSION_NAMES:
        return "longitude"
    if dimension_name in LATITUDE_DIMENSION_NAMES:
        return "latitude"
    if dimension_name in TIME_DIMENSION_NAMES:
        return "time"
    return "generic"

def get_dimension_labels(data_array: xr.DataArray, dimension_name: str, dimension_type: str = ""):
    dtype = get_dimension_type(dimension_name) if dimension_type == "" else dimension_type

    if dtype == "time":
        if data_array[dimension_name].dtype == cftime.datetime:
            return np.datetime_as_string([np.datetime64(str(d)) for d in data_array[dimension_name].values], timezone="UTC").tolist()
        elif np.issubdtype(data_array[dimension_name].dtype, str):
            return data_array[dimension_name].values.tolist()
        elif np.issubdtype(data_array[dimension_name].dtype, np.datetime64):
            return np.datetime_as_string(data_array[dimension_name].values, timezone="UTC").tolist()
        else:
            raise ValueError(f"Unsupported time dimension dtype: {data_array[dimension_name].dtype}")
    return data_array[dimension_name].values.tolist()

class DatasetMetadata:
    def __init__(self) -> None:
        self.axis_labels = []
        self.dataset_dict = {}
        self.x_max = -1
        self.y_max = -1
        self.z_max = -1

    def read_from_file(self, file_path):
        with open(file_path, 'r') as f:
            data = json.load(f)
            self.axis_labels = data["axis_labels"]
            self.x_max = data["x_max"]
            self.y_max = data["y_max"]
            self.z_max = data["z_max"]
            self.x_dimension_name = data["x_dimension_name"]
            self.y_dimension_name = data["y_dimension_name"]
            self.z_dimension_name = data["z_dimension_name"]
            self.dataset_dict = data["dataset_dict"]
        
    def save_to_file(self, file_path):
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        with open(file_path, 'w') as f:
            data = {
                "axis_labels": self.axis_labels,
                "x_max": self.x_max,
                "y_max": self.y_max,
                "z_max": self.z_max,
                "x_dimension_name": self.x_dimension_name,
                "y_dimension_name": self.y_dimension_name,
                "z_dimension_name": self.z_dimension_name,
                "dataset_dict": self.dataset_dict
            }
            json.dump(data, f)

    def get_all_parameters(self):
        return list(self.dataset_dict["data_vars"].keys())

    def test_dimensions(self, dataset: Dataset, dimensions: list[str]) -> str:
        for dim in dimensions:
            if dim and dataset.dims.get(dim):
                return dim
        return ""


    def load_from_dataset(self, ds: xr.Dataset):
        self.dataset_dict = ds.to_dict(data=False)
        
        dims_any, _, _ = parse_parameter_dimensions_from_dataset(ds)
        self.x_dimension_name = dims_any[2]
        self.x_dimension_type = get_dimension_type(self.x_dimension_name)
        self.y_dimension_name = dims_any[1]
        self.y_dimension_type = get_dimension_type(self.y_dimension_name)
        self.z_dimension_name = dims_any[0]
        self.z_dimension_type = get_dimension_type(self.z_dimension_name)

        self.x_max = ds.sizes.get(self.x_dimension_name)
        self.y_max = ds.sizes.get(self.y_dimension_name)
        self.z_max = ds.sizes.get(self.z_dimension_name)
        
        self.axis_labels = {
            "x": get_dimension_labels(ds, self.x_dimension_name, self.x_dimension_type),
            "y": get_dimension_labels(ds, self.y_dimension_name, self.y_dimension_type),
            "z": get_dimension_labels(ds, self.z_dimension_name, self.z_dimension_type)
        }

# Opens the 3D and, if applicable, the 4D-RGBA parameter data from given parameter name and dataset.
def open_parameter_data(ds: xr.Dataset, parameter: str | CompositeRgbParameter) -> xr.DataArray:
    if type(parameter) == CompositeRgbParameter:
        bands_data = parameter.get_parameter_data(ds)
        band_dimension_name = next((d for d in bands_data.dims if d in BAND_DIMENSION_NAMES), None)
        # 7 = all valid, non NaN
        # & 1 = R valid, R is not NaN
        # & 2 = G valid, G is not NaN
        # & 4 = B valid, B is not NaN
        byte_masked_nan_mask = (bands_data.notnull().astype(np.uint8) * xr.DataArray([1, 2, 4], dims=[bands_data.dims[-1]])).sum(dim=bands_data.dims[-1]).astype('uint8')
        lower_bounds = xr.DataArray(parameter.rgb_scale_lower_bounds, dims=[band_dimension_name], coords={band_dimension_name: bands_data[bands_data.dims[-1]]})
        scalars = xr.DataArray(parameter.rgb_scale_upper_bounds - parameter.rgb_scale_lower_bounds, dims=[band_dimension_name], coords={band_dimension_name: bands_data[bands_data.dims[-1]]})
        combined_and_scaled_rgba = xr.concat([((bands_data - lower_bounds) / scalars * 255).astype(np.uint8), byte_masked_nan_mask.assign_coords({band_dimension_name: "nan_mask"}).expand_dims(band_dimension_name)], dim=band_dimension_name)
        return bands_data.isel({band_dimension_name: 0}), combined_and_scaled_rgba
    else:
        return ds[parameter], None

class ParameterMetadataParser:
    def __init__(self, config: ServerConfig, min_max_values_approximate_only: bool, dataset_path: str, dataset_id: str) -> None:
        self.min_max_values_approximate_only = min_max_values_approximate_only
        self.config = config
        self.dataset_path = dataset_path
        self.dataset_id = dataset_id        
        
    def discover_metadata_for_parameter(self, existing_metadata: DiscoveredParameterMetadata, parameter: str | CompositeRgbParameter):
        parameter_name = parameter if type(parameter) == str else parameter.name
        print(f"** parameter {parameter_name}")
        first, last, minimum_value, maximum_value, median_of_1quantiles, median_of_99quantiles, resample_resolution = None, None, None, None, None, None, None
        if existing_metadata:
            first = existing_metadata.first_valid_time_slice
            last = existing_metadata.last_valid_time_slice
            minimum_value = existing_metadata.minimum_value
            maximum_value = existing_metadata.maximum_value
            median_of_1quantiles = existing_metadata.median_of_1quantiles
            median_of_99quantiles = existing_metadata.median_of_99quantiles
            min_max_approximate_only = existing_metadata.min_max_values_approximate_only
            resample_resolution = existing_metadata.resample_resolution
        parameter_data, _ = open_parameter_data(open_dataset(self.config, self.dataset_path), parameter)
        if first == None or last == None:
            (first, last) = self.find_first_and_last_slices(parameter_data)
            print(f" - Detected first/last Z slice: {first} - {last}")
        if (minimum_value == None or maximum_value == None or median_of_1quantiles == None or median_of_99quantiles == None) or (min_max_approximate_only and not self.min_max_values_approximate_only):
            (minimum_value, maximum_value, median_of_1quantiles, median_of_99quantiles) = self.find_min_max_and_quantiles(parameter_data, self.dataset_id, parameter_name, first, last, self.min_max_values_approximate_only)
            min_max_approximate_only = self.min_max_values_approximate_only
            print(f" - Detected min/max: {minimum_value} - {maximum_value} Median 1%: {median_of_1quantiles} Median 99%: {median_of_99quantiles}")
        if resample_resolution == None:
            resample_resolution = self.detect_resample_resolution(parameter_data, self.dataset_id, parameter, first)
            print(f" - Detected resolution {resample_resolution}")
        return DiscoveredParameterMetadata(parameter_name, int(first), int(last), minimum_value, maximum_value, median_of_1quantiles, median_of_99quantiles, int(resample_resolution), min_max_approximate_only)

    def test_resample_resolution(self, data: np.ndarray, blocksize: int):
        # we would expect at least 4 blocks in each direction to make a meaningful test
        if data.shape[0] <= blocksize * 4 or data.shape[1] <= blocksize * 4:
            return False
        all_global = True
        scaled = cv2.resize(data, None, fx=1.0/blocksize, fy=1.0/blocksize, interpolation=cv2.INTER_LINEAR)
        for iy, ix in np.ndindex(scaled.shape):
            new = scaled[iy, ix]
            old = data[iy*blocksize, ix*blocksize]
            all_local = new == old or (math.isnan(new) and math.isnan(old))
            if not all_local:
                all_global = False
                break
        return all_global

    def detect_resample_resolution(self, parameter_data: xr.DataArray, dataset_id: str, parameter: str, sample_time_slice: int):
        print("Detect resample resolution", end="", flush=True)
        if dataset_id == "esdc-2.1.1-high-res" and parameter in ["air_temperature_2m","max_air_temperature_2m","min_air_temperature_2m","precipitation_era5","radiation_era5"]:
            return 3
        block = parameter_data[sample_time_slice].values
        for blocksize in range(32, 1, -1):
            if self.test_resample_resolution(block, blocksize):
                return blocksize
        return 1

    def find_min_max_and_quantiles(self, parameter_data: xr.DataArray, dataset_id: str, parameter: str, first_time_slice: int, last_time_slice: int, approximate_only: bool = False):
        z_samples_target = 50
        z_sampling_step = max(1, math.floor(float(last_time_slice - first_time_slice + 1) / z_samples_target)) if approximate_only else 1
        z_samples_actual = math.ceil(float(last_time_slice - first_time_slice + 1) / z_sampling_step)
        minimum_value = np.inf
        maximum_value = -np.inf
        observations = 0
        local_1quantiles = []
        local_99quantiles = []
        
        print(f"Find min, max and quantile values {f'[approximate only, {z_samples_actual} Z-slice samples]' if approximate_only else ''} - ", end="", flush=True)
        for t in range(first_time_slice, last_time_slice, z_sampling_step):
            # print("Gathering data for time slice", t)
            observations += 1
            values = patch_data(parameter_data[t].values, dataset_id, parameter)
            mask = np.isfinite(values)
            if not np.any(mask):
                continue
            masked_values = values[mask]
            local_min = np.min(masked_values)
            local_max = np.max(masked_values)
            local_1quantile = np.nanquantile(masked_values, 0.01, method="closest_observation")
            local_99quantile = np.nanquantile(masked_values, 0.99, method="closest_observation")

            minimum_value = min(minimum_value, local_min)
            maximum_value = max(maximum_value, local_max)
            if local_1quantile != np.nan:
                local_1quantiles.append(local_1quantile)
            if local_99quantile != np.nan:
                local_99quantiles.append(local_99quantile)

        median_of_1quantiles = np.nanmedian(local_1quantiles) # not an accurate 1% quantile, but good enough for our purposes
        median_of_99quantiles = np.nanmedian(local_99quantiles) # not an accurate 99% quantile, but good enough for our purposes

        # if any of the values are NaN, write error to print
        if not np.isfinite(minimum_value) or not np.isfinite(maximum_value) or not np.isfinite(median_of_1quantiles) or not np.isfinite(median_of_99quantiles):
            print(f"Warning: NaN/Inf values detected in min/max/quantile calculations for {parameter} - min {minimum_value} - max {maximum_value} - 1% quant {median_of_1quantiles} - 99% quant {median_of_99quantiles}, setting to min/max to 0 if nan and medians to min/max if nan.")
            if not np.isfinite(minimum_value):
                minimum_value = 0
            if not np.isfinite(maximum_value):
                maximum_value = 0
            if not np.isfinite(median_of_1quantiles):
                median_of_1quantiles = minimum_value
            if not np.isfinite(median_of_99quantiles):
                median_of_99quantiles = maximum_value

        print(f"Min: {minimum_value} Max: {maximum_value} Accesses: {observations}")
        return (float(minimum_value), float(maximum_value), float(median_of_1quantiles), float(median_of_99quantiles))

    def find_first_and_last_slices(self, parameter_data: xr.DataArray):
        # Assumes that there is exactly one region which has atleast one value defined in each time slice in [first, last] (upper bound inclusive)
        print("Find first and last valid time slice - ", end="", flush=True)
        z_max = parameter_data.shape[0]
        first_found = 0
        last_found = z_max - 1
        accesses = 0
        steps = [
            math.floor(0.05 * z_max),
            math.floor(0.005 * z_max),
            1
        ]
        accesses = 0
        # Find first valid Z slice
        checked_z_slices = {}
        def check_z_slice_for_any_valid_value(z_value):
            if z_value in checked_z_slices:
                return checked_z_slices[z_value]
            nonlocal accesses
            accesses += 1
            r = np.any(np.isfinite(parameter_data[z_value].values))
            checked_z_slices[z_value] = r
            return r
    
        lower_hint = 0
        upper_hint = z_max - 1
        done = False
        for step in steps:
            for z in range(0, z_max, max(step, 1)):
                if check_z_slice_for_any_valid_value(z):
                    upper_hint = z
                    done = True
                    print(f"1st loop - found something at {z}")
                    break
                lower_hint = z
            if done:
                break
        print(f"Got hints for first found value: {lower_hint} - {upper_hint}")
        for z in range(lower_hint, upper_hint + 1):
            if check_z_slice_for_any_valid_value(z):
                first_found = z
                print(f"2nd loop - found something at {z}")
                break
        print(f"First: {first_found}")

        # Find last time slice
        lower_hint = 0
        upper_hint = z_max - 1
        done = False
        for step in steps:
            for z in range(z_max - 1, 0, -max(step, 1)):
                if check_z_slice_for_any_valid_value(z):
                    lower_hint = z
                    done = True
                    print(f"1st loop - found something at {z}")
                    break
                upper_hint = z
            if done:
                break
        print(f"Got hints for last found value: {lower_hint} - {upper_hint}")
        for z in reversed(range(lower_hint, upper_hint + 1)):
            if check_z_slice_for_any_valid_value(z):
                last_found = z
                print(f"2nd loop - found something at {z}")
                break        
        print(f"First: {first_found} Last: {last_found} Accesses: {accesses}")
        return (first_found, last_found)

class Dataset:
    def __init__(self, server_config: ServerConfig, dataset_config: dict, base_dir: str, tile_size_2d: int, tile_size_3d: int) -> None:
        self.dataset_config = DatasetConfig(dataset_config)
        self.id = self.dataset_config.id
        self.short_name = self.dataset_config.short_name
        self.base_dir = base_dir
        self.ds: xr.Dataset = None
        self.calculate_anomalies: bool = self.dataset_config.calculate_anomalies
        self.force_tile_generation: bool = self.dataset_config.force_tile_generation
        self.all_valid_parameters: list[str] = []
        self.real_parameters: list[str] = []
        self.virtual_parameters: list[str] = []
        self.composite_rgb_parameters: list[CompositeRgbParameter] = []
        self.parameter_block_list = self.dataset_config.ignored_parameters
        self.parameter_allow_list = self.dataset_config.only_parameters
        self.parameter_metadata: dict[str, DiscoveredParameterMetadata] = {}
        self.block_2d_contents_by_dim_and_lod = []
        self.block_3d_contents_by_lod = []
        self.pre_generation_sparsity_2d_tiles = self.dataset_config.pre_generation_sparsity_2d_tiles
        self.max_lod_2d = self.dataset_config.max_lod_2d
        self.max_lod_3d = self.dataset_config.max_lod_3d
        self.min_max_values_approximate_only = self.dataset_config.min_max_values_approximate_only
        self.allow_data_downloads = self.dataset_config.allow_data_downloads
        self.server_config = server_config
        self.enable_2d_tiles = self.dataset_config.enable_2d_tiles
        self.enable_3d_tiles = self.dataset_config.enable_3d_tiles
        self.enable_3d_extremes = self.dataset_config.enable_3d_extremes
        self.target_3d_tile_formats = self.dataset_config.target_3d_tile_formats
        self.x_max: int = -1
        self.y_max: int = -1
        self.z_max: int = -1
        self.allow_float64_in_compressed_tiles = self.dataset_config.allow_float64_in_compressed_tiles
        self.tile_size_2d = tile_size_2d
        self.tile_size_3d = tile_size_3d
        self.use_offline_metadata = self.dataset_config.use_offline_metadata
        self.meta_data = DatasetMetadata()

    def clone_without_data(self):
        # return a copy of this object without the data property
        ds = copy.deepcopy(self)
        ds.data = None
        return ds

    def get_dimension_name(self, dimension: Dimension) -> str:
        if dimension == Dimension.X:
            return self.meta_data.x_dimension_name
        elif dimension == Dimension.Y:
            return self.meta_data.y_dimension_name
        return self.meta_data.z_dimension_name

    def load_metadata(self, tile_directory):
        file_path = os.path.join(tile_directory, f"dataset_metadata-{self.id}.json")
        if self.use_offline_metadata:
            self.meta_data.read_from_file(file_path)
        else:
            self.meta_data.load_from_dataset(self.ds)
            self.meta_data.save_to_file(file_path)
        self.x_max = self.meta_data.x_max
        self.y_max = self.meta_data.y_max
        self.z_max = self.meta_data.z_max

    def __str__(self) -> str:
        return json.dumps(self.get_minimal_representation())

    def get_minimal_representation(self):
        return { "id": self.id, "shortName": self.short_name }

    def get_detailed_representation(self):
        result = self.meta_data.dataset_dict
        data_vars = json.loads(json.dumps(result["data_vars"]).replace("NaN,", '"",'))
        for parameter in data_vars.copy():
            if parameter not in self.real_parameters:
                del data_vars[parameter]
        for parameter in self.real_parameters:
            for (key, val) in self.parameter_metadata[parameter].to_dict().items():
                data_vars[parameter][key] = val
                
        for rgb_parameter in self.composite_rgb_parameters:
            data_vars[rgb_parameter.name] = rgb_parameter.meta_data

        if self.calculate_anomalies:
            source = data_vars.copy()
            for d in source:
                new = deepcopy(data_vars[d])
                del new["minimum_value"]
                del new["maximum_value"]
                data_vars[d + ANOMALY_PARAMETER_ID_SUFFIX] = new
        result["data_vars"] = data_vars
        result["dims_ordered"] = [self.meta_data.z_dimension_name, self.meta_data.y_dimension_name, self.meta_data.x_dimension_name]
        result["indices"] = self.meta_data.axis_labels
        result["max_lod_2d"] = self.max_lod_2d
        result["max_lod_3d"] = self.max_lod_3d
        result["enable_2d_tiles"] = self.enable_2d_tiles
        result["enable_3d_tiles"] = self.enable_3d_tiles
        result["enable_3d_extremes"] = self.enable_3d_extremes
        result["3d_tile_formats"] = self.target_3d_tile_formats
        result["sparsity"] = self.pre_generation_sparsity_2d_tiles
        result["allow_data_downloads"] = self.allow_data_downloads
        return result

    def get_parameters_from_meta_data(self):
        all_parameters = self.meta_data.get_all_parameters()
        virtual_parameter_names = []
        rgb_composite_parameters = [p for p in self.dataset_config.rgb_parameters]
        
        if len(self.parameter_allow_list) > 0:
            real_parameter_names = [p for p in all_parameters if p in self.parameter_allow_list]
        else:
            real_parameter_names = [p for p in all_parameters if p not in self.parameter_block_list]
        real_parameter_names = [p for p in real_parameter_names if len(self.meta_data.dataset_dict["data_vars"][p]["shape"]) == 3]

        if self.calculate_anomalies:
            virtual_parameter_names.extend([p + ANOMALY_PARAMETER_ID_SUFFIX for p in real_parameter_names])
        return (real_parameter_names, virtual_parameter_names, rgb_composite_parameters)

    def get_composite_rgb_parameter_names(self):
        return [p.name for p in self.dataset_config.rgb_parameters]

    def open(self, tile_directory):
        if not self.use_offline_metadata:
            self.ds = open_dataset(self.server_config, self.dataset_config.dataset_path)
        self.load_metadata(tile_directory)
        self.real_parameters, self.virtual_parameters, self.composite_rgb_parameters = self.get_parameters_from_meta_data()
        print(f"        > Real parameters: [{', '.join([p for p in self.real_parameters])}]")
        print(f"        > Virtual parameters: [{', '.join([p for p in self.virtual_parameters])}]")
        print(f"        > Composite RGB parameters: [{', '.join([p for p in self.get_composite_rgb_parameter_names()])}]")
        self.all_valid_parameters = self.real_parameters + self.virtual_parameters + self.get_composite_rgb_parameter_names()
        if self.max_lod_2d == -1: # i.e. max lod was not set in config
            self.max_lod_2d = calculate_max_lod(self.tile_size_2d, [self.meta_data.z_max, self.meta_data.y_max, self.meta_data.x_max])
        if self.max_lod_3d == -1: # i.e. max lod was not set in config
            self.max_lod_3d = self.calculate_max_lod(self.tile_size_3d)
            

    def calculate_max_lod(self, tile_size: int):
        dims = [self.meta_data.z_max, self.meta_data.y_max, self.meta_data.x_max]
        if tile_size <= 0 or min(dims) <= 0 or max(dims) <= 0:
            return 0
        desired_max_lod = math.ceil(-math.log2(tile_size / max(dims)))
        largest_lod_possible = math.floor(math.log2(min(dims)))
        return max(0, min(desired_max_lod, largest_lod_possible))

    def generate_block_file_indices(self):
        self.block_2d_contents_by_dim_and_lod = []
        for index_dimension in Dimension:
            width = self.x_max if index_dimension == Dimension.Z or index_dimension == Dimension.Y else self.y_max
            height = self.y_max if index_dimension == Dimension.Z else self.meta_data.z_max

            content_info = []
            for lod in range(0, self.max_lod_2d + 1):
                lod_factor = pow(0.5, lod)
                adjusted_width = lod_factor * width
                adjusted_height = lod_factor * height
                x_tiles = math.ceil(adjusted_width / self.tile_size_2d)
                y_tiles = math.ceil(adjusted_height / self.tile_size_2d)
                content_info.append((x_tiles, y_tiles))
            self.block_2d_contents_by_dim_and_lod.append(content_info)


        self.block_3d_contents_by_lod = []
        for lod in range(0, self.max_lod_3d + 1):
            lod_factor = pow(0.5, lod)
            adjusted_width = lod_factor * self.x_max
            adjusted_height = lod_factor * self.y_max
            x_tiles = math.ceil(adjusted_width / self.tile_size_3d)
            y_tiles = math.ceil(adjusted_height / self.tile_size_3d)
            self.block_3d_contents_by_lod.append((x_tiles, y_tiles))

class ServerConfig:
    def __init__(self, tile_size_2d, tile_size_3d) -> None:
        self.datasets = {}
        self.tile_cache_directory = ""
        self.tile_size_2d = tile_size_2d
        self.tile_size_3d = tile_size_3d
        self.pre_generation_threads = 0
        self.max_download_directory_size_bytes = 1024 * 1024 * 1024 * 10  # 10 GB

    def try_migrate_config_file(self):
        top_level_key_migrations = {
            "dataCubeBaseDir": "datasetBaseDir",
            "dataCubes": "datasets"
        }
        dataset_level_key_migrations = {
            "mainCubePath": "datasetPath"
        }
        with open('config.json', 'r') as config_file:
            config_text = config_file.read()
            source_config = json.loads(config_text)
            target_config = deepcopy(source_config)
            changed = False
            for top_level_key in source_config:
                if type(source_config[top_level_key]) == list:
                    source_datasets = source_config[top_level_key]
                    for source_dataset in source_datasets:
                        for dataset_key in source_dataset:
                            if dataset_key in dataset_level_key_migrations:
                                target_config[top_level_key][source_datasets.index(source_dataset)][dataset_level_key_migrations[dataset_key]] = source_dataset[dataset_key]
                                del target_config[top_level_key][source_datasets.index(source_dataset)][dataset_key]
                                changed = True
                if top_level_key in top_level_key_migrations:
                    target_config[top_level_key_migrations[top_level_key]] = target_config[top_level_key]
                    del target_config[top_level_key]
                    changed = True

        if changed:
            print("* Migrated config file to new format")
            with open('config.json', 'w') as config_file:
                config_file.write(json.dumps(target_config, indent=4))

    def read_from_config_file(self):
        self.try_migrate_config_file()
        with open('config.json', 'r') as config_file:
            config_text = config_file.read()
            config = json.loads(config_text)
            self.tile_cache_directory = config["tileCacheDir"]
            self.pre_generation_threads = config.get("preGenerationThreads") or DEFAULT_PRE_GENERATION_THREADS
            self.base_dir = config["datasetBaseDir"]
            for dataset_config in config["datasets"]:
                if "hidden" in dataset_config and dataset_config["hidden"]:
                    continue
                self.datasets[dataset_config["id"]] = Dataset(self, dataset_config, self.base_dir, self.tile_size_2d, self.tile_size_3d)

class TileDiskStorage:
    def __init__(self, directory: str, datasets: dict[str, Dataset], tile_size_2d: int, tile_size_3d: int) -> None:
        self.base_directory = directory
        self.directory_2d_tiles = os.path.join(directory, str(tile_size_2d))
        self.directory_3d_tiles = os.path.join(directory, f"{tile_size_3d}_3d")
        self.datasets = datasets

    def get_metadata_path(self, filetype: str, dataset: Dataset, parameter: str = None):
        if parameter:
            return os.path.join(self.base_directory, f"{filetype}-{dataset.id}-{parameter}.json")
        return os.path.join(self.base_directory, f"{filetype}-{dataset.id}.json")

    def try_migrate_dimension_folders(self, dataset: Dataset):
        old_names = ["Time", "Latitude", "Longitude"]
        first = True
        for param in dataset.all_valid_parameters:
            lookup_dir = os.path.join(self.directory_2d_tiles, dataset.id, param)
            if not os.path.exists(lookup_dir):
                continue
            existing_names = os.listdir(lookup_dir)
            for n in range(3):
                old_name = old_names[n]
                new_name = dataset.get_dimension_name(Dimension(n))
                if old_name == new_name or not old_name in existing_names:
                    continue
                if first: 
                    print(f"{dataset.id} -- Migrating old lon/lat/time dimension folders to new names (matching their actual dimension names)")
                    first = False
                source = os.path.join(self.directory_2d_tiles, dataset.id, param, old_name)
                destination = os.path.join(self.directory_2d_tiles, dataset.id, param, new_name)
                shutil.move(source, destination)
        
    def get_tile_path(self, tile: Union[Tile2D, Tile3D]):
        if type(tile) == Tile2D:
            return self.get_tile_2d_path(tile)
        return self.get_tile_3d_path(tile)
    
    def get_block_file_2d_path(self, dataset: Dataset, parameter: str, index_dimension: Dimension, indexValue: int):
        return os.path.join(self.directory_2d_tiles, dataset.id, parameter, dataset.get_dimension_name(index_dimension), f"{indexValue}")

    def get_tile_2d_path(self, tile: Tile2D):
        return os.path.join(self.directory_2d_tiles, tile.dataset_id, tile.parameter, self.datasets[tile.dataset_id].get_dimension_name(tile.index_dimension), f"{tile.index_value}.{tile.lod}.{tile.tx}.{tile.ty}.tile2d")
    
    def get_block_file_3d_path(self, dataset: Dataset, parameter: str, lod: int, tileZ: int, tile_format: str):
        extension = TILE_3D_FORMAT_TO_FILE_EXTENSION.get(tile_format)
        return os.path.join(self.directory_3d_tiles, dataset.id, parameter, f"{lod}.{tileZ}.block3d{extension}")

    def get_tile_3d_path(self, tile: Tile3D):
        return os.path.join(self.directory_3d_tiles, tile.dataset_id, tile.parameter, f"{tile.lod}.{tile.tx}.{tile.ty}.{tile.tz}.tile3d")
    
    def get_event_data_path(self, dataset_id: str, parameter: str, event_type: str):
        return os.path.join(self.directory_3d_tiles, dataset_id, parameter, "extreme_events", f"events_{parameter}_{event_type}_minified.bin")

    def get_index_mask_block_file_path(self, dataset: Dataset, parameter: str, event_type: str, lod: int, tileZ: int):
        return os.path.join(self.directory_3d_tiles, dataset.id, parameter, "extreme_index_masks", f"index_mask_{parameter}_{event_type}_{lod}.{tileZ}.block3d")
    
class TileMemoryCache:
    def __init__(self) -> None:
        self.cache = {}

    def tile_exists(self, tile: Tile2D | Tile3D):
        return tile.get_hash_key() in self.cache
    
    def put_data(self, tile: Tile2D | Tile3D, data):
        self.cache[tile.get_hash_key()] = data

    def get_data(self, tile: Tile2D | Tile3D):
        return self.cache[tile.get_hash_key()]

class DiscoveredParameterMetadata:
    def __init__(self, name: str, first_valid_time_slice: int = None, last_valid_time_slice: int = None, minimum_value: float = None, maximum_value: float = None, median_of_1quantiles: float = None, median_of_99quantiles: float = None, resample_resolution: int = None, min_max_values_approximate_only: bool = False, vlq_payload_bytes_per_tile: dict[str, int] = None) -> None:
        self.name = name
        self.first_valid_time_slice = first_valid_time_slice
        self.last_valid_time_slice = last_valid_time_slice
        self.minimum_value = minimum_value
        self.maximum_value = maximum_value
        self.median_of_1quantiles = median_of_1quantiles
        self.median_of_99quantiles = median_of_99quantiles
        self.resample_resolution = resample_resolution
        self.min_max_values_approximate_only = min_max_values_approximate_only
        self.vlq_payload_bytes_per_tile = vlq_payload_bytes_per_tile

    def is_complete(self) -> bool:
        return self.first_valid_time_slice != None and self.last_valid_time_slice != None and self.minimum_value != None and self.maximum_value != None and self.resample_resolution != None and self.median_of_1quantiles != None and self.median_of_99quantiles != None

    def __str__(self) -> str:
        return str(self.to_dict())

    def __repr__(self) -> str:
        return self.to_dict()

    def from_dict(self, dict: dict):
        for property, value in dict.items():
            setattr(self, property, value)
        return self

    def to_dict(self) -> dict:
        d = {}
        for property, value in vars(self).items():
            d[property] = value
        return d
    
class DataType(enum.Enum):
    Float = 0,
    RGB = 1,

class Tile2D:
    @staticmethod
    def get_tiles_in_range(tile_size: int, dataset: Dataset, parameter: str, index_dimension: Dimension, index_values: Iterable, lods: Iterable, pixel_x_range: Iterable = None, pixel_y_range: Iterable = None, data_type: DataType = DataType.Float) -> List[Tile2D]:
        width = dataset.x_max if index_dimension == Dimension.Z or index_dimension == Dimension.Y else dataset.y_max
        height = dataset.y_max if index_dimension == Dimension.Z else dataset.z_max

        tiles = []
        for index_value in index_values:
            for lod in lods:
                lod_factor = pow(0.5, lod)
                data_width_at_current_lod = lod_factor * width
                data_height_at_current_lod = lod_factor * height
                x_tiles = math.ceil(data_width_at_current_lod / tile_size)
                y_tiles = math.ceil(data_height_at_current_lod / tile_size)
                if pixel_x_range is not None:
                    first_x_tile = math.floor(pixel_x_range[0] * lod_factor / tile_size)
                    last_x_tile = math.ceil(pixel_x_range[1] * lod_factor / tile_size)
                if pixel_y_range is not None:
                    first_y_tile = math.floor(pixel_y_range[0] * lod_factor / tile_size)
                    last_y_tile = math.ceil(pixel_y_range[1] * lod_factor / tile_size)
                for ty in range(y_tiles):
                    for tx in range(x_tiles):
                        if pixel_x_range is not None and (tx < first_x_tile or tx >= last_x_tile):
                            continue
                        if pixel_y_range is not None and (ty < first_y_tile or ty >= last_y_tile):
                            continue
                        tiles.append(Tile2D(tile_size, dataset.id, parameter, index_dimension, index_value, lod, tx, ty, data_type=data_type))
        return tiles

    def __init__(self, tile_size: int, dataset_id: str, parameter: str, index_dimension: Dimension, index_value: int, lod: int, tx: int, ty: int, data_type = DataType.Float) -> None:
        self.tile_size = tile_size
        self.dataset_id = dataset_id
        self.parameter = parameter
        self.index_dimension = index_dimension
        self.index_value = index_value
        self.lod = lod
        self.tx = tx
        self.ty = ty
        self.data = None
        self.data_type = data_type

    def is_anomaly_tile(self):
        return self.parameter.endswith(ANOMALY_PARAMETER_ID_SUFFIX)

    def get_anomaly_tile(self):
        return Tile2D(self.tile_size, self.dataset_id, self.parameter + ANOMALY_PARAMETER_ID_SUFFIX, self.index_dimension, self.index_value, self.lod, self.tx, self.ty, self.data_type)
    
    def get_hash_key(self):
        return "-".join([self.dataset_id, self.parameter, str(self.index_dimension.value), str(self.index_value), str(self.lod), str(self.tx), str(self.ty)])

    def generate_from_data(self, source_data: Union[xr.DataArray, np.ndarray, DataSourceProxy], tile_compressor: TileCompressor, global_z_offset: int = 0, global_y_offset: int = 0, global_x_offset: int = 0, added_compression_error: float = 0.0, resample_resolution: int = 1, compress_lossless: bool = False, from_2d_data_source: bool = False, compressed_dtype: np.dtype = np.float32) -> np.ndarray:
        lod_factor = pow(2, self.lod)
        inverse_lod_factor = 1 / lod_factor
        global_y_index = self.tx if self.index_dimension == Dimension.X else self.ty
        
        # Global Z = always local Y
        # Global Y = [index dim Z] local Y, [index dim X] local X
        # Global X = always local X
        
        # if index_dimension == Dimension.Z: # Glo
        #     index_range = range(z_start, z_end, dataset.pre_generation_sparsity_2d_tiles)
        #     local_x_range = range(x_start, x_end, dataset.pre_generation_sparsity_2d_tiles)
        #     local_y_range = range(y_start, y_end, dataset.pre_generation_sparsity_2d_tiles)            
        # elif index_dimension == Dimension.Y:
        #     index_range = range(0, dataset.y_max, dataset.pre_generation_sparsity_2d_tiles)
        #     local_x_range = range(x_start, x_end, dataset.pre_generation_sparsity_2d_tiles)
        #     local_y_range = range(z_start, z_end, dataset.pre_generation_sparsity_2d_tiles)                        
        # elif index_dimension == Dimension.X:
        #     index_range = range(0, dataset.x_max, dataset.pre_generation_sparsity_2d_tiles)
        #     local_x_range = range(y_start, y_end, dataset.pre_generation_sparsity_2d_tiles)
        #     local_y_range = range(z_start, z_end, dataset.pre_generation_sparsity_2d_tiles)

        global_z_slice = slice(lod_factor *         (self.ty * self.tile_size - global_z_offset),  lod_factor * (       (self.ty + 1) * self.tile_size - global_z_offset))
        global_y_slice = slice(lod_factor *  (global_y_index * self.tile_size - global_y_offset),  lod_factor * ((global_y_index + 1) * self.tile_size - global_y_offset))
        global_x_slice = slice(lod_factor *         (self.tx * self.tile_size - global_x_offset),  lod_factor * (       (self.tx + 1) * self.tile_size - global_x_offset))

        if len(source_data.shape) == 2 or from_2d_data_source:
            if self.index_dimension == Dimension.Z:
                data_values = source_data[global_y_slice, global_x_slice]
            elif self.index_dimension == Dimension.Y:
                data_values = source_data[global_z_slice, global_x_slice]
            elif self.index_dimension == Dimension.X:
                data_values = source_data[global_z_slice, global_y_slice]
        elif len(source_data.shape) >= 3:
            if self.index_dimension == Dimension.Z:
                data_values = source_data[self.index_value - global_z_offset, global_y_slice, global_x_slice]
            elif self.index_dimension == Dimension.Y:
                data_values = source_data[global_z_slice, self.index_value - global_y_offset, global_x_slice]
            elif self.index_dimension == Dimension.X:
                data_values = source_data[global_z_slice, global_y_slice, self.index_value - global_x_offset]
        else:
            raise ValueError(f"Unsupported data shape {source_data.shape} for tile generation")

        if lod_factor > 1:
            sample_instead_of_resize = False
            chunked = type(data_values) == xr.DataArray and data_values.chunks
            if chunked:
                c = data_values.chunks
                if (len(c[0]) > (data_values.shape[0] * inverse_lod_factor)) or (len(c[1]) > (data_values.shape[1] * inverse_lod_factor)):
                    sample_instead_of_resize = True
            if sample_instead_of_resize and type(data_values) == xr.DataArray:
                data_values = sample_data_array_2d(data_values, lod_factor)
            else:
                v = data_values.values if type(data_values) == xr.DataArray else data_values
                data_values = cv2.resize(v, None, fx=inverse_lod_factor, fy=inverse_lod_factor, interpolation=cv2.INTER_LINEAR) # propogates NaN values
        
        adjusted_resample_resolution = max(1, resample_resolution * inverse_lod_factor)
        if (resample_resolution * inverse_lod_factor) % 1 != 0: 
            adjusted_resample_resolution = 1 # Resolutions that are not a whole number are not yet supported
        adjusted_resample_resolution = int(adjusted_resample_resolution)
        if adjusted_resample_resolution > 1:
            # Pad the data if there is the edge case of an irregular resample at the beginning and the end of the block, for x/y respectively
            resample_x_offset_start = adjusted_resample_resolution - ((self.tx * self.tile_size) % adjusted_resample_resolution)
            resample_y_offset_start = adjusted_resample_resolution - ((self.ty * self.tile_size) % adjusted_resample_resolution)
            resample_x_offset_end = (self.tile_size - resample_x_offset_start) % adjusted_resample_resolution
            resample_y_offset_end = (self.tile_size - resample_y_offset_start) % adjusted_resample_resolution
            if resample_x_offset_start > 0 and resample_x_offset_end > 0 and resample_x_offset_start + resample_x_offset_end < adjusted_resample_resolution:
                data_values = np.hstack((data_values, np.broadcast_to(data_values[:,-1][:,None], (data_values.shape[0], adjusted_resample_resolution - 1))))
            if resample_y_offset_start > 0 and resample_y_offset_end > 0 and resample_y_offset_start + resample_y_offset_end < adjusted_resample_resolution:
                data_values = np.vstack((data_values, np.broadcast_to(data_values[-1,:][None,:], (adjusted_resample_resolution - 1, data_values.shape[1]))))
            data_values = data_values[::adjusted_resample_resolution,::adjusted_resample_resolution]

        return self.compress_data(data_values, tile_compressor, adjusted_resample_resolution, added_compression_error, compressed_dtype)

    def exists_as_intermediate_single_file(self, path: str):
        return os.path.exists(path)

    def read_from_intermediate_single_file(self, path: str, suffix = ""):
        file = open(path + suffix, "rb")
        return file.read()

    def write_to_intermediate_single_file(self, path: str, compressed_data: bytes, suffix = ""):
        with open(path + suffix, "wb") as f:
            f.write(compressed_data)

    def get_tile_metadata_bytes(self, resample_resolution: int, nan_mask_length: int, max_error_or_magic_number: float, compressed_dtype: np.dtype = np.float32) -> bytes:
        tile_version_and_flags = TILE_VERSION | (TILE_VERSION_FLAG_RGB_UINT8 if self.data_type == DataType.RGB else (TILE_VERSION_FLAG_FLOAT32 if compressed_dtype == np.float32 else TILE_VERSION_FLAG_FLOAT64))
        return TILE_FORMAT_MAGIC_BYTES + struct.pack("<I", tile_version_and_flags) + struct.pack("<I", resample_resolution) + struct.pack("<I", nan_mask_length) + struct.pack("<d", max_error_or_magic_number)
    
    def compress_data(self, source_values: Union[xr.DataArray, np.ndarray], tile_compressor: TileCompressor, resample_resolution: int = 1, added_compression_error: float = 0.0, compressed_dtype: np.dtype = np.float32):
        if np.all(np.isnan(source_values)):
            return self.get_tile_metadata_bytes(0, 0, NAN_TILE_MAGIC_NUMBER, compressed_dtype)
        # if np.any(np.isnan(source_values)):
        #     print("yes")
        tile_data = np.full((self.tile_size, self.tile_size), np.nan, compressed_dtype) if self.data_type == DataType.Float else np.full((self.tile_size, self.tile_size, 4), RGB_NAN_ALPHA_VALUE, np.uint8)
        tile_data[:source_values.shape[0], :source_values.shape[1]] = source_values

        statistical_data_bytes = struct.pack("<d", np.nanmin(source_values)) + struct.pack("<d", np.nanmax(source_values)) + struct.pack("<d", np.nanmean(source_values)) + struct.pack("<d", np.nanvar(source_values))

        if tile_compressor.is_currently_encoding_losslessly():
            compressed_tile_data = tile_compressor.compress_tile_data((self.tx, self.ty), tile_data)
            return self.get_tile_metadata_bytes(resample_resolution, 0, LOSSLESS_TILE_MAGIC_NUMBER, compressed_dtype) + statistical_data_bytes + compressed_tile_data

        nan_mask = np.full((self.tile_size, self.tile_size), 0, np.float32)
        nan_mask[np.isnan(tile_data)] = np.nan

        np.nan_to_num(tile_data, copy=False)
        compressed_nan_mask = tile_compressor.compress_nan_mask(nan_mask)
        compressed_tile_data = tile_compressor.compress_tile_data((self.tx, self.ty), tile_data, self.is_anomaly_tile())
        decompressed_tile_data = tile_compressor.decompress_tile_data(compressed_tile_data)
        errors = np.abs(decompressed_tile_data[:source_values.shape[0], :source_values.shape[1]] - source_values)
        max_error = np.nanmax(errors, initial=0) + added_compression_error
        return self.get_tile_metadata_bytes(resample_resolution, len(compressed_nan_mask), max_error, compressed_dtype) + statistical_data_bytes + compressed_nan_mask + compressed_tile_data

    def decompress(self, data: bytes, tile_compressor: TileCompressor, compressed_dtype: np.dtype = np.float32) -> tuple:
        tile_format = data[:4]
        if tile_format != TILE_FORMAT_MAGIC_BYTES:
            raise Exception("Invalid tile format")
        tile_version_and_flags = struct.unpack("<i", data[4:8])[0]
        if (tile_version_and_flags & TILE_VERSION_MASK) != TILE_VERSION:
            raise Exception("Invalid tile version")
        dtype_present = np.float32 if (tile_version_and_flags & TILE_VERSION_FLAG_FLOAT32) != 0 else (np.float64 if (tile_version_and_flags & TILE_VERSION_FLAG_FLOAT64) != 0 else np.uint8)
        if (self.data_type == DataType.Float and dtype_present != compressed_dtype) or (self.data_type == DataType.RGB and dtype_present != np.uint8):
            raise Exception(f"Tile data type mismatch during decompression. Expected {compressed_dtype} but found {dtype_present}")
        max_compression_error_or_magic_number = struct.unpack("<d", data[16:24])[0]
        if max_compression_error_or_magic_number == NAN_TILE_MAGIC_NUMBER:
            return (np.full((self.tile_size, self.tile_size), np.nan), 0.0) if self.data_type == DataType.Float else (np.full((self.tile_size, self.tile_size, 4), RGB_NAN_ALPHA_VALUE, np.uint8), 0.0)
        resample_resolution = struct.unpack("<I", data[8:12])[0]
        if resample_resolution != 1:
            print("Warning, non-1 resample resolution found during decompression. This case is not implemented")
        if max_compression_error_or_magic_number == LOSSLESS_TILE_MAGIC_NUMBER:
            tile_data = np.frombuffer(tile_compressor.decompress_tile_data(data[56:], True), compressed_dtype).reshape((self.tile_size, self.tile_size)) if self.data_type == DataType.Float else np.frombuffer(tile_compressor.decompress_tile_data(data[56:], True), np.uint8).reshape((self.tile_size, self.tile_size, 4))
            return (tile_data, 0.0)
        nan_mask_length = struct.unpack("<I", data[12:16])[0]
        nan_mask_compressed = data[56:56+nan_mask_length]
        nan_mask_bytes = tile_compressor.decompress_nan_mask(nan_mask_compressed)
        nan_mask = np.frombuffer(nan_mask_bytes, np.float32).reshape((self.tile_size, self.tile_size))
        tile_data = tile_compressor.decompress_tile_data(data[56+nan_mask_length:], False) + nan_mask
        return (tile_data, max_compression_error_or_magic_number)

    def get_values_from_cache(self, generation_cache: TileGenerationCache, tile_compressor: TileCompressor, compressed_dtype: np.dtype = np.float32) -> tuple:
        return self.decompress(generation_cache.get_data(self), tile_compressor, compressed_dtype)

    def __str__(self):
        return f"{self.dataset_id} / {self.parameter} / Index: {self.index_dimension.name}, {self.index_value} / LoD: {self.lod} / XY: {self.tx},{self.ty}"
        


class Tile3D:
    @staticmethod
    def get_tiles_in_range(tile_size: int, dataset: Dataset, parameter: str, z_values: Iterable[int], lod: int, y_values: Iterable[int] = [], x_values: Iterable[int] = []) -> List[Tile3D]:
        width = dataset.x_max
        height = dataset.y_max 
        depth = dataset.z_max

        tiles = []
        lod_factor = pow(0.5, lod)
        adjusted_width = lod_factor * width
        adjusted_height = lod_factor * height

        max_z = math.ceil(lod_factor * depth / tile_size) - 1
        x_tiles = math.ceil(adjusted_width / tile_size)
        y_tiles = math.ceil(adjusted_height / tile_size)
        for z in [z for z in z_values if z <= max_z]:
            for y in y_values if len(y_values) > 0 else range(y_tiles):
                for x in x_values if len(x_values) > 0 else range(x_tiles):
                    tiles.append(Tile3D(tile_size, dataset.id, parameter, lod, x, y, z))
        return tiles

    def __init__(self, tile_size: int, dataset_id: str, parameter: str, lod: int, x: int, y: int, z: int) -> None:
        self.tile_size = tile_size
        self.dataset_id = dataset_id
        self.parameter = parameter
        self.lod = lod
        self.tx = x
        self.ty = y
        self.tz = z
        self.data = None

    def is_anomaly_tile(self):
        return self.parameter.endswith(ANOMALY_PARAMETER_ID_SUFFIX)

    def get_anomaly_tile(self):
        return Tile3D(self.tile_size, self.dataset_id, self.parameter + ANOMALY_PARAMETER_ID_SUFFIX, self.lod, self.tx, self.ty, self.tz)

    def get_hash_key(self):
        return "-".join(["3D",self.dataset_id, self.parameter, str(self.lod), str(self.tx), str(self.ty), str(self.tz)])

    def generate_and_compress_from_data(self, source_data: Union[xr.DataArray, np.ndarray, DataSourceProxy], tile_compressor: TileCompressor, z_offset: int = 0, added_compression_error: float = 0.0, resample_resolution: int = 1, y_offset: int = 0, x_offset: int = 0, quantile_index_mask: np.ndarray | None = None, nan_factor_mask: np.ndarray = None, compressed_dtype: np.dtype = np.float32) -> bytes:
        lod_factor = pow(2, self.lod)
        
        z_slice = slice(lod_factor * (self.tz * self.tile_size - z_offset), lod_factor * ((self.tz + 1) * self.tile_size - z_offset))
        y_slice = slice(lod_factor * (self.ty * self.tile_size - y_offset), lod_factor * ((self.ty + 1) * self.tile_size - y_offset))
        x_slice = slice(lod_factor * (self.tx * self.tile_size - x_offset), lod_factor * ((self.tx + 1) * self.tile_size - x_offset))

        if len(source_data.shape) == 3:
            data_values = source_data[z_slice, y_slice, x_slice]
            if quantile_index_mask is not None:
                quantile_indices = quantile_index_mask[z_slice, y_slice, x_slice]
            else:
                quantile_indices = np.full(data_values.shape, fill_value=NON_EXTREME_QUANTILE_INDEX, dtype=np.uint8)
                
            if nan_factor_mask is not None:
                nan_factors = nan_factor_mask[z_slice, y_slice, x_slice]
            else:
                # set to 0 where data is NaN, and 1 where data is valid
                nan_factors = np.full(data_values.shape, fill_value=NAN_FACTOR_MASK_VALID_VALUE, dtype=np.uint8)
                nan_factors[np.isnan(data_values)] = 0
        else:
            print(f"Invalid, passed {len(source_data.shape)}-dimensonal source data to tile generation")

        if lod_factor > 1:
            raise NotImplementedError("3D LoD > 0 generate_from_data not yet implemented")
            # inverse_lod_factor = 1 / lod_factor
            # data_values = downscale_fast_3d(data_values, inverse_lod_factor)
            # quantile_indices = downscale_fast_3d(quantile_indices, inverse_lod_factor) # TODO: not sure if scientifically accurate
        
        adjusted_resample_resolution = 1

        return self.compress_data(data_values, tile_compressor, quantile_indices, nan_factors, adjusted_resample_resolution, added_compression_error, compressed_dtype)

    def exists_as_intermediate_single_file(self, path: str):
        return os.path.exists(path)

    def read_from_intermediate_single_file(self, path: str, suffix = ""):
        file = open(path + suffix, "rb")
        return file.read()

    def write_to_intermediate_single_file(self, path: str, compressed_data: bytes, suffix = ""):
        with open(path + suffix, "wb") as f:
            f.write(compressed_data)

    def get_tile_metadata_bytes(self, resample_resolution: int, quantile_index_mask_length: int, max_error_or_magic_number: float, compressed_dtype: np.dtype):
        tile_version_with_flags = TILE_VERSION_3D | (TILE_VERSION_FLAG_FLOAT32 if compressed_dtype == np.float32 else TILE_VERSION_FLAG_FLOAT64)
        return TILE_FORMAT_MAGIC_BYTES + struct.pack("<I", tile_version_with_flags) + struct.pack("<I", resample_resolution) + struct.pack("<I", quantile_index_mask_length) + struct.pack("<d", max_error_or_magic_number)

    def compress_data(self, source_values: Union[xr.DataArray, np.ndarray], tile_compressor: TileCompressor, source_quantile_index_mask: np.ndarray, source_nan_factor_mask: np.ndarray, resample_resolution: int = 1, added_compression_error: float = 0.0, compressed_dtype: np.dtype = np.float32) -> bytes:
        if np.all(np.isnan(source_values)):
            return self.get_tile_metadata_bytes(0, 0, NAN_TILE_MAGIC_NUMBER, compressed_dtype)
        
        if source_quantile_index_mask.dtype != np.uint8:
            raise ValueError(f"Invalid quantile index mask dtype {source_quantile_index_mask.dtype}, expected dtype uint8")
        
        tile_data = np.full((self.tile_size, self.tile_size, self.tile_size), np.nan, compressed_dtype)
        tile_data[:source_values.shape[0], :source_values.shape[1], :source_values.shape[2]] = source_values
        quantile_index_mask = np.full((self.tile_size, self.tile_size, self.tile_size), NON_EXTREME_QUANTILE_INDEX, np.uint8)
        quantile_index_mask[:source_quantile_index_mask.shape[0], :source_quantile_index_mask.shape[1], :source_quantile_index_mask.shape[2]] = source_quantile_index_mask

        nan_factor_mask = np.full((self.tile_size, self.tile_size, self.tile_size), NAN_FACTOR_MASK_NAN_VALUE, np.uint8)
        nan_factor_mask[:source_nan_factor_mask.shape[0], :source_nan_factor_mask.shape[1], :source_nan_factor_mask.shape[2]] = source_nan_factor_mask

        statistical_data_bytes = struct.pack("<d", np.nanmin(source_values)) + struct.pack("<d", np.nanmax(source_values)) + struct.pack("<d", np.nanmean(source_values)) + struct.pack("<d", np.nanvar(source_values))

        compressed_masks = tile_compressor.compress_nan_mask(np.stack((quantile_index_mask, nan_factor_mask), axis=0))
        
        if tile_compressor.is_currently_encoding_losslessly():
            compressed_tile_data = tile_compressor.compress_tile_data((self.tx, self.ty, self.tz), tile_data)
            return self.get_tile_metadata_bytes(resample_resolution, len(compressed_masks), LOSSLESS_TILE_MAGIC_NUMBER, compressed_dtype) + statistical_data_bytes + compressed_masks + compressed_tile_data

        np.nan_to_num(tile_data, copy=False)
        compressed_tile_data = tile_compressor.compress_tile_data((self.tx, self.ty, self.tz), tile_data, self.is_anomaly_tile())
        decompressed_tile_data = tile_compressor.decompress_tile_data(compressed_tile_data)
        errors = np.abs(decompressed_tile_data[:source_values.shape[0], :source_values.shape[1]] - source_values)
        max_error = np.nanmax(errors, initial=0) + added_compression_error
        print(f"Tile {self} -- max compression error: {max_error}")
        return self.get_tile_metadata_bytes(resample_resolution, len(compressed_masks), max_error, compressed_dtype) + statistical_data_bytes + compressed_masks + compressed_tile_data

    def decompress(self, data: bytes, tile_compressor: TileCompressor, compressed_dtype: np.dtype = np.float32) -> tuple:
        tile_format = data[:4]
        if tile_format != TILE_FORMAT_MAGIC_BYTES:
            raise Exception("Invalid tile format")
        tile_version_and_flags = struct.unpack("<I", data[4:8])[0]
        if (tile_version_and_flags & TILE_VERSION_MASK) != TILE_VERSION_3D:
            raise Exception("Invalid tile version")
        dtype_present = np.float32 if (tile_version_and_flags & TILE_VERSION_FLAG_FLOAT32) != 0 else np.float64
        if dtype_present != compressed_dtype:
            raise Exception("Tile compressed dtype does not match the requested dtype for decompression")
        max_compression_error_or_magic_number = struct.unpack("<d", data[16:24])[0]
        if max_compression_error_or_magic_number == NAN_TILE_MAGIC_NUMBER:
            return (
                np.full((self.tile_size, self.tile_size, self.tile_size), np.nan), 
                0.0, 
                np.full((self.tile_size, self.tile_size, self.tile_size), NON_EXTREME_QUANTILE_INDEX, np.uint8), 
                np.full((self.tile_size, self.tile_size, self.tile_size), NAN_FACTOR_MASK_NAN_VALUE, np.uint8)
            )
        resample_resolution = struct.unpack("<I", data[8:12])[0]
        if resample_resolution != 1:
            print("Warning, non-1 resample resolution found during decompression. This case is not implemented")
        masks_length = struct.unpack("<I", data[12:16])[0]
        masks_compressed = data[56:56+masks_length]
        masks_bytes = tile_compressor.decompress_nan_mask(masks_compressed)
        masks = np.frombuffer(masks_bytes, np.uint8).reshape((2, self.tile_size, self.tile_size, self.tile_size))
        quantile_index_mask = masks[0]
        nan_factor_mask = masks[1]
        if max_compression_error_or_magic_number == LOSSLESS_TILE_MAGIC_NUMBER:
            tile_data = np.frombuffer(tile_compressor.decompress_tile_data(data[56+masks_length:], True), compressed_dtype).reshape((self.tile_size, self.tile_size, self.tile_size))
            return (tile_data, 0.0, quantile_index_mask, nan_factor_mask)
        tile_data = tile_compressor.decompress_tile_data(data[56+masks_length:], False)
        print(f"Tile {self} -- decompressed with max compression error: {max_compression_error_or_magic_number}")
        return (tile_data, max_compression_error_or_magic_number, quantile_index_mask, nan_factor_mask)

    def get_values_from_cache(self, generation_cache: TileGenerationCache, tile_compressor: TileCompressor, compressed_dtype: np.dtype = np.float32) -> tuple:
        return self.decompress(generation_cache.get_data(self), tile_compressor, compressed_dtype)

    def __str__(self):
        return f"{self.dataset_id} / {self.parameter} / LoD: {self.lod} / XYZ: {self.tx},{self.ty},{self.tz}"


class TileGenerationCache:
    def __init__(self, tile_disk_storage: TileDiskStorage, save_on_disk=False, tile_format: str = "") -> None:
        # By default, intermediate tiles are generated in memory. 
        # If that is not feasible, they can be saved on disk instead (passing True to the "save_on_disk" argument)
        self.save_on_disk = save_on_disk
        self.tile_format = tile_format
        self.tile_disk_storage = tile_disk_storage
        self.cache = {}

    def get_tile_path(self, tile: Union[Tile2D, Tile3D]):
        extension = TILE_3D_FORMAT_TO_FILE_EXTENSION.get(self.tile_format, "") if type(tile) == Tile3D else ""
        return self.tile_disk_storage.get_tile_path(tile) + extension

    def tile_exists(self, tile: Union[Tile2D, Tile3D]):
        if self.save_on_disk:
            return tile.exists_as_intermediate_single_file(self.get_tile_path(tile))
        else:
            return tile.get_hash_key() in self.cache
    
    def put_data(self, tile: Union[Tile2D, Tile3D], data):
        if self.save_on_disk:
            tile.write_to_intermediate_single_file(self.get_tile_path(tile), data)
        else:
            self.cache[tile.get_hash_key()] = data

    def get_data(self, tile: Union[Tile2D, Tile3D]):
        if self.save_on_disk:
            return tile.read_from_intermediate_single_file(self.get_tile_path(tile))
        else:
            return self.cache[tile.get_hash_key()]

    def put_uncompressed_data(self, tile: Union[Tile2D, Tile3D], data):
        if self.save_on_disk:
            tile.write_to_intermediate_single_file(self.get_tile_path(tile), data, UNCOMPRESSED_SUFFIX)
        else:
            self.cache[tile.get_hash_key() + UNCOMPRESSED_SUFFIX] = data

    def get_uncompressed_data(self, tile: Union[Tile2D, Tile3D]):
        if self.save_on_disk:
            return tile.read_from_intermediate_single_file(self.tile_disk_storage.get_tile_path(tile), UNCOMPRESSED_SUFFIX)
        else:
            return self.cache[tile.get_hash_key() + UNCOMPRESSED_SUFFIX]
        
    def clear(self):
        if self.save_on_disk:
            pass # self.tile_disk_storage.clear() [not implemented]
        else:
            self.cache.clear()

    def get_size(self):
        if self.save_on_disk:
            return -1 # not supported
        else:
            return sum([len(data) for data in self.cache.values()])


class ZfpCompressor:
    def __init__(self) -> None:
        self.tolerance = -1.0
        self.rate = -1.0
        self.precision = -1.0

    def encode(self, data: np.ndarray):
        import zfpy
        return zfpy.compress_numpy(data, self.tolerance, self.rate, self.precision)

    def decode(self, data: bytes):
        import zfpy
        return zfpy.decompress_numpy(data)

class TileServer:
    def __init__(self, widget_mode = False) -> None:
        self.force_lossless_compression = widget_mode
        self.TILE_SIZE_2D = DEFAULT_TILE_SIZE_2D
        self.TILE_SIZE_3D = DEFAULT_TILE_SIZE_3D
        self.config = ServerConfig(self.TILE_SIZE_2D, self.TILE_SIZE_3D)
        self.tile_disk_storage = None
        self.datasets: dict[str, Dataset] = {}
        self.ignore_tile_cache = False
        self.widget_mode = widget_mode
        self.tile_compressor = TileCompressor(TILE_FORMAT_BLOSC_LZ4 if self.force_lossless_compression else TILE_FORMAT_ZFP)
        self.next_request_id = 0
        self.next_request_group_id = 0
        self.request_progress = {}
        self.download_tasks = {}
        self.next_download_task_id = 0
    

    def update_progress(self, request_group_id: int, request_id: int, done: int, total: int = -1):
        if not self.request_progress.get(request_group_id):
            self.request_progress[request_group_id] = {}
        if total >= 0:
            self.request_progress[request_group_id][request_id] = [ done, total ]
        else:
            self.request_progress[request_group_id][request_id][0] = done
        # print(f"Update progress: {self.request_progress} for request group {request_group_id}")
        if self.widget_mode:
            current: dict = self.request_progress[request_group_id]
            done = sum(c[0] for c in current.values())
            total = sum(c[1] for c in current.values())
            self.widget_update_progress([done, total])

    def startup_widget(self, data_source: Union[xr.DataArray, np.ndarray], use_lexcube_chunk_caching: bool):
        if type(data_source) == xr.DataArray and not data_source.chunks:
            print("Xarray input object does not have chunks. You can re-open with 'chunks={}' to enable dask for caching and progress reporting functionality - but may be overall slower for small data sets.")
        dask_cache = Cache(2e9)  # Leverage two gigabytes of memory
        dask_cache.register()
        self.data_source = patch_dataset(data_source)
        #self.data_source = open_parameter_data(self.data_source)
        self.data_source_proxy = DataSourceProxy(self.data_source)
        self.guessed_data_type_from_widget_data_source = DataType.RGB if len(self.data_source.shape) == 4 else DataType.Float
        self.tile_memory_cache = TileMemoryCache()
        self.use_data_source_proxy = use_lexcube_chunk_caching

    def startup_standalone(self):
        print("* Reading configuration (config.json)")
        self.config.read_from_config_file()
        self.datasets = self.config.datasets
        print(f"* Found {len(self.datasets)} dataset definition{'s' if len(self.datasets) != 1 else ''}")

        for c in self.datasets.values():
            print(f"    * Opening dataset {c.id}")
            c.open(self.config.tile_cache_directory)
            c.generate_block_file_indices()
        print("* Finished opening datasets")

        self.tile_disk_storage = TileDiskStorage(os.path.join(self.config.tile_cache_directory, f"tile_version_{TILE_VERSION}"), self.datasets, self.TILE_SIZE_2D, self.TILE_SIZE_3D)
        os.makedirs(self.config.tile_cache_directory, exist_ok=True)

        for dataset in self.datasets.values():
            try:
                self.tile_disk_storage.try_migrate_dimension_folders(dataset)
            except:
                pass
            self.discover_metadata_for_all_parameters(dataset)
                

        self.delete_all_files_in_dataset_download_directory_without_active_tasks()
        
        print("* Startup finished.")

    def discover_metadata_for_all_parameters(self, dataset: Dataset):
        if self.try_read_metadata(dataset):
            return
        threads = self.config.pre_generation_threads
        print(f"* Discover metadata for dataset {dataset.id} (using {threads} threads)")
        metadata = {}
        with multiprocessing.Pool(threads) as pool:
            metadatas = pool.starmap(ParameterMetadataParser(self.config, dataset.min_max_values_approximate_only, dataset.dataset_config.dataset_path, dataset.id).discover_metadata_for_parameter, [(dataset.parameter_metadata.get(p), p) for p in dataset.real_parameters + dataset.composite_rgb_parameters])
            for m in metadatas:
                metadata[m.name] = m.to_dict()
        metadata_file_path = os.path.join(self.config.tile_cache_directory, f"discovered_metadata-{dataset.id}.json")
        with open(metadata_file_path, "w") as f:
            json.dump(metadata, f)
        self.try_read_metadata(dataset)

    def load_vlq_metadata(self, dataset: Dataset):
        metadata_file_path = os.path.join(self.config.tile_cache_directory, f"discovered_metadata-{dataset.id}.json")
        if not os.path.exists(metadata_file_path):
            print(f"VLQ metadata file not found for dataset {dataset.id} at expected path {metadata_file_path}")
            return
        with open(metadata_file_path, "r") as f:
            json_data = json.load(f)
        for parameter in json_data:
            if parameter in dataset.parameter_metadata and json_data[parameter].get("vlq_payload_bytes_per_tile"):
                dataset.parameter_metadata[parameter].vlq_payload_bytes_per_tile = json_data[parameter]["vlq_payload_bytes_per_tile"]
    
    def persist_vlq_metadata_after_generation_on_disk(self, dataset: Dataset):
        metadata_file_path = os.path.join(self.config.tile_cache_directory, f"discovered_metadata-{dataset.id}.json")
        with open(metadata_file_path, "r") as f:
            json_data = json.load(f)
        for parameter in json_data:
            if parameter in dataset.parameter_metadata:
                md = dataset.parameter_metadata[parameter]
                json_data[parameter]["vlq_payload_bytes_per_tile"] = md.vlq_payload_bytes_per_tile

        with open(metadata_file_path, "w") as f:
            json.dump(json_data, f)

    def try_read_metadata(self, dataset: Dataset):
        metadata_file_path = os.path.join(self.config.tile_cache_directory, f"discovered_metadata-{dataset.id}.json")
        if not os.path.exists(metadata_file_path):
            return False
        try:
            json_data = json.load(open(metadata_file_path, "r"))
        except:
            print(f"Error reading metadata file {metadata_file_path}. Will re-discover metadata for dataset {dataset.id}")
            return False
        complete = True
        for parameter in json_data:
            dataset.parameter_metadata[parameter] = DiscoveredParameterMetadata(parameter).from_dict(json_data[parameter])
            if not dataset.parameter_metadata[parameter].is_complete() or (not dataset.min_max_values_approximate_only and dataset.parameter_metadata[parameter].min_max_values_approximate_only):
                complete = False
        for parameter in dataset.real_parameters + dataset.get_composite_rgb_parameter_names():
            if dataset.parameter_metadata.get(parameter) == None:
                complete = False
                break
        if complete:
            for p in dataset.composite_rgb_parameters:
                p.set_metadata(dataset.meta_data, dataset.parameter_metadata[p.name])

        return complete
    
    def pre_register_requests(self, requests):
        request_group_id = self.next_request_group_id
        self.next_request_group_id += 1
        for request in requests:
            request["request_id"] = self.next_request_id
            request["request_group_id"] = request_group_id
            xys_or_xyzs = request["xys"] if "xys" in request else request["xyzs"]
            self.update_progress(request_group_id, request["request_id"], 0, len(xys_or_xyzs))
            self.next_request_id += 1
    
    def handle_tile_request_widget(self, request):
        request_id = request["request_id"]
        request_group_id = request["request_group_id"]
        lod = request["lod"]
        before = time.perf_counter()

        data = bytearray()
        sizes = []
        tiles_generated = 0
        cache_hits = 0
        # with self.register_progress(request_id, len(xys)):
        tile_type = request["tileType"]
        
        if tile_type == "2d":
            xys = request["xys"]
            index_dimension = dimension_mapping[request["indexDimension"]]
            index_value = request["indexValue"]
            for xy in xys:
                t = Tile2D(self.TILE_SIZE_2D, "", "", index_dimension, index_value, lod, xy[0], xy[1], data_type=self.guessed_data_type_from_widget_data_source)
                tile_cached = self.tile_memory_cache.tile_exists(t)
                if tile_cached:
                    cache_hits += 1
                    d = self.tile_memory_cache.get_data(t)
                else:
                    ds = self.data_source_proxy if self.use_data_source_proxy else self.data_source
                    d = t.generate_from_data(ds, self.tile_compressor, compressed_dtype=ds.dtype)
                    tiles_generated += 1
                    self.tile_memory_cache.put_data(t, d)
                data += d
                sizes.append(len(d))
                self.update_progress(request_group_id, request_id, len(sizes))
        elif tile_type == "3d":
            xyzs = request["xyzs"]
            for xyz in xyzs:
                t = Tile3D(self.TILE_SIZE_3D, "", "", lod, xyz[0], xyz[1], xyz[2])
                tile_cached = self.tile_memory_cache.tile_exists(t)
                if tile_cached:
                    cache_hits += 1
                    d = self.tile_memory_cache.get_data(t)
                else:
                    ds = self.data_source_proxy if self.use_data_source_proxy else self.data_source
                    d = t.generate_and_compress_from_data(ds, self.tile_compressor, compressed_dtype=ds.dtype)
                    tiles_generated += 1
                    self.tile_memory_cache.put_data(t, d)
                data += d
                sizes.append(len(d))
                self.update_progress(request_group_id, request_id, len(sizes))
        time_took_secs = time.perf_counter() - before
        # print(f"request {request_id}, index {index_dimension.name}, value {index_value}, lod {lod}, xys {xys} (cache hits: {cache_hits})")
        # if tiles_generated > 0:
        #     print(f"Finished generating tiles, took {round(time_took_secs * 1000)} milliseconds ({round(time_took_secs * 1000 / tiles_generated)} per tile)")
        return ({"response_type": "tile_data", "metadata": request, "dataSizes": sizes}, [bytes(data)])
            
    async def handle_tile_request_standalone(self, socketio, sender_id, request_data):
        tile_type = request_data["tileType"]
        dataset_id = request_data["datasetId"]
        parameter = request_data["parameter"]
        lod = request_data["lod"]
        dataset = self.datasets.get(dataset_id)
        if not (dataset and parameter in self.datasets[dataset_id].all_valid_parameters):
            return print(f"Dataset id or parameter not found ({dataset_id} / {parameter})")
        
        tiles = []
        if tile_type == "2d":
            index_dimension = dimension_mapping[request_data["indexDimension"]]
            index_value = request_data["indexValue"]
            if (index_value % dataset.pre_generation_sparsity_2d_tiles) != 0:
                return print(f"Bad request for index value {index_value} in {index_dimension.name}")
            xys = request_data["xys"]
            for xy in xys:
                tiles.append(Tile2D(self.TILE_SIZE_2D, dataset, parameter, index_dimension, index_value, lod, xy[0], xy[1]))
            blockfile = BlockFile2D(self.tile_disk_storage, dataset, parameter, index_dimension, index_value)
        elif tile_type == "3d":
            xyzs = request_data["xyzs"]
            tile_format = request_data["tileFormat"]
            index_mask_event_type = request_data["indexMaskEventType"] if "indexMaskEventType" in request_data else ""
            z_values = list(set([xyz[2] for xyz in xyzs]))
            if len(z_values) > 1:
                return print(f"Request cannot be answered, multiple z values requested: {z_values}")
            for xyz in xyzs:
                tiles.append(Tile3D(self.TILE_SIZE_3D, dataset, parameter, lod, xyz[0], xyz[1], xyz[2]))
            blockfile = BlockFile3D(self.tile_disk_storage, dataset, parameter, lod, z_values[0], tile_format, index_mask_event_type=index_mask_event_type)
        else:
            return print(f"Invalid tile type {tile_type}")
        
        if not blockfile.exists():
            return print(f"Request cannot be answered, block file not found: {blockfile.path}")

        blockfile.load_header()
        (sizes, data) = blockfile.get_tile_data(tiles)

        await socketio.emit("tile_data", { "metadata": request_data, "dataSizes": sizes, "data": bytes(data) }, to=sender_id)

    async def handle_event_request_standalone(self, socketio, sender_id, request_data):
        event_type = request_data["eventType"]
        dataset_id = request_data["datasetId"]
        parameter = request_data["parameter"]
        
        dataset = self.datasets.get(dataset_id)
        if not (dataset and parameter in self.datasets[dataset_id].all_valid_parameters):
            return print(f"Dataset id or parameter not found ({dataset_id} / {parameter})")
        
        try:
            event_data_path = self.tile_disk_storage.get_event_data_path(dataset_id, parameter, event_type)

            if not os.path.exists(event_data_path):
                return print(f"Event data file not found for dataset {dataset_id}, parameter {parameter}, event type {event_type} at expected path {event_data_path}")
            
            with open(event_data_path, "rb") as f:
                data = f.read()
                await socketio.emit("event_data", { "metadata": request_data, "data": bytes(data) }, to=sender_id)                
        except Exception as e:
            return print(f"Error occurred while fetching event data path: {e}")
    

    def get_dataset_download_path(self):
        return os.path.join(self.config.tile_cache_directory or "", "dataset-downloads")
    
    def delete_all_files_in_dataset_download_directory_without_active_tasks(self):
        download_path = self.get_dataset_download_path()
        os.makedirs(download_path, exist_ok=True)
        for f in os.listdir(download_path):
            f_path = os.path.join(download_path, f)
            found = False
            for task in self.download_tasks.values():
                if task["target_path"] == f_path or task["zip_target_path"] == f_path:
                    found = True
                    break
            if not found:
                try:
                    if os.path.isfile(f_path):
                        os.remove(f_path)
                    elif os.path.isdir(f_path):
                        shutil.rmtree(f_path)
                    print(f"Deleted old download file {f_path} not associated with any active download task")
                except Exception as e:
                    print(f"Error deleting file {f_path}: {e}")


    def delete_files_in_dataset_download_directory_if_over_limit(self, estimated_added_size_bytes: int = 0):
        download_path = self.get_dataset_download_path()
        os.makedirs(download_path, exist_ok=True)
        total_size = 0
        for dirpath, dirnames, filenames in os.walk(download_path):
            for f in filenames:
                fp = os.path.join(dirpath, f)
                total_size += os.path.getsize(fp)
        
        if total_size >= self.config.max_download_directory_size_bytes:
            for t in self.download_tasks.values():
                if t["status"] == "in_progress":
                    continue
                for f in [t["target_path"], t["zip_target_path"]]:
                    if os.path.exists(f):
                        file_size = os.path.getsize(f)
                        os.remove(f)
                        total_size -= file_size
                        print(f"Deleted download file {f} from task {t['task_id']} to free up space")
                if total_size < self.config.max_download_directory_size_bytes - estimated_added_size_bytes:
                    break

        return total_size < self.config.max_download_directory_size_bytes

    def initiate_download_task(self, dataset_id: str, parameter: str, zmin: int, zmax: int, ymin: int, ymax: int, xmin: int, xmax: int):
        dataset = self.datasets.get(dataset_id)
        if not dataset:
            return print(f"Dataset id not found ({dataset_id})")

        # first, delete all files in dataset download directory that do not have a task in download_tasks
        self.delete_all_files_in_dataset_download_directory_without_active_tasks()

        download_path = self.get_dataset_download_path()
        os.makedirs(download_path, exist_ok=True)
        source_path = dataset.ds.encoding["source"]
        target_name_parts = os.path.splitext(os.path.basename(source_path))
        target_name = target_name_parts[0] + f"-subset-z{zmin}_{zmax}-y{ymin}_{ymax}-x{xmin}_{xmax}" + target_name_parts[1]
        target_path = os.path.join(download_path, target_name)
        
        # check if download_tasks already has a task for the same target_path
        for task in self.download_tasks.values():
            if task["target_path"] == target_path:
                return { "success": True, "task_id": task["task_id"], "status": task["status"] }

        # based on the file size of source_path (dir or file), guess how big the output will be
        source_size_bytes = 0
        if os.path.isfile(source_path):
            source_size_bytes = os.path.getsize(source_path)
        elif os.path.isdir(source_path):
            for dirpath, dirnames, filenames in os.walk(source_path):
                for f in filenames:
                    fp = os.path.join(dirpath, f)
                    source_size_bytes += os.path.getsize(fp)
        else:
            print(f"Source path for dataset {dataset_id} not found: {source_path}")
            return { "success": False, "message": "Source path not found" }
        total_values = (zmax - zmin) * (ymax - ymin) * (xmax - xmin)
        estimated_output_size_bytes = source_size_bytes * (total_values / (dataset.z_max * dataset.y_max * dataset.x_max)) * 1.1
        
        if estimated_output_size_bytes > self.config.max_download_directory_size_bytes:
            return { "success": False, "message": "Download request too large" }
        
        # if over the limit, delete files from oldest tasks until under half the limit
        enough_space_to_continue = self.delete_files_in_dataset_download_directory_if_over_limit(estimated_output_size_bytes)
        if not enough_space_to_continue:
            return { "success": False, "message": "Download request cannot be served right now, try again later" }

        thread = threading.Thread(target=save_dataset_subset, args=(self.config, source_path, target_path, parameter, zmin, zmax, ymin, ymax, xmin, xmax))
        thread.start()

        np.random.seed()
        task_id = sha512(np.random.bytes(32)).hexdigest()[:16]
        self.next_download_task_id += 1
        
        task = {
            "task_id": task_id,
            "thread": thread,
            "source_path": source_path,
            "target_path": target_path,
            "zip_target_path": target_path + ".zip",
            "status": "in_progress"
        }
        self.download_tasks[task_id] = task
        
        return { "success": True, "task_id": task_id, "status": task["status"] }
    
    def get_download_status(self, task_id: int):
        task = self.download_tasks.get(task_id)
        if not task:
            return None
        if task["thread"].is_alive():
            task["status"] = "in_progress"
        else:
            if os.path.exists(task["zip_target_path"]) or (os.path.exists(task["target_path"]) and os.path.isfile(task["target_path"])):
                task["status"] = "completed"
            else:
                task["status"] = "failed"
        return {
            "task_id": task["task_id"],
            "status": task["status"]
        }
        
    def get_download_file_path(self, task_id: int):
        task = self.download_tasks.get(task_id)
        if not task:
            return None
        if os.path.exists(task["zip_target_path"]):
            return task["zip_target_path"]
        if os.path.exists(task["target_path"]) and os.path.isfile(task["target_path"]):
            return task["target_path"]
        print(f"Download file for task {task_id} not found")
        return None

class BlockFile2D:
    def __init__(self, tile_disk_storage: TileDiskStorage, dataset: Dataset, parameter: str, index_dimension: Dimension, index_value: int) -> None:
        self.path = tile_disk_storage.get_block_file_2d_path(dataset, parameter, index_dimension, index_value)
        self.block_contents = dataset.block_2d_contents_by_dim_and_lod[index_dimension.value]
        self.data = None
        self.block_sizes = []
        self.total_tiles = sum([s[0] * s[1] for s in self.block_contents])

    def exists(self):
        return os.path.exists(self.path)

    def load_header(self):
        self.file = open(self.path, "rb")
        header_data = self.file.read(4 * self.total_tiles)
        for i in range(self.total_tiles):
            self.block_sizes.append(int.from_bytes(header_data[i*4:(i+1)*4], byteorder="little"))

    def get_tile_data(self, tiles: List[Tile2D]):
        total = bytearray()
        sizes = []
        header_offset = self.total_tiles * 4
        block_index_offset = sum([s[0] * s[1] for s in self.block_contents[:tiles[0].lod]]) # offset from previous LoDs, assumed LoD is the same throughout all tiles
        block_indices = []
        for tile in tiles:
            block_indices.append(block_index_offset + tile.ty * self.block_contents[tile.lod][0] + tile.tx) # collect indices of all requested tiles
        group_function: Callable[[List[int]], int] = lambda indices: indices[0] - indices[1]
        for _, g in groupby(enumerate(block_indices), group_function): # group adjacent requested tiles to read them together
            group = list(map(itemgetter(1), g))
            my_byte_offset = header_offset + sum([s for s in self.block_sizes[:group[0]]])
            self.file.seek(my_byte_offset)
            for e in group:
                my_byte_size = self.block_sizes[e]
                total += self.file.read(my_byte_size)
                sizes.append(my_byte_size)
        return (sizes, total)

    @staticmethod
    def convert_intermediate_single_tile_files(tile_size: int, tile_disk_storage: TileDiskStorage, generation_cache: TileGenerationCache, dataset: Dataset, parameter: str, index_dimension: Dimension, index_value: int):
        # tiles are in correct order already
        tiles: List[Tile2D] = Tile2D.get_tiles_in_range(tile_size, dataset, parameter, index_dimension, [index_value], range(0, dataset.max_lod_2d + 1))
        
        header_data = bytearray()
        body_data = bytearray()
        for t in tiles:
            tile_data = generation_cache.get_data(t)
            header_data += int.to_bytes(len(tile_data), 4, byteorder="little")
            body_data += tile_data

        with open(tile_disk_storage.get_block_file_2d_path(dataset, parameter, index_dimension, index_value), "wb") as file:
            file.write(header_data)
            file.write(body_data)

        if generation_cache.save_on_disk:
            for t in tiles:
                os.remove(tile_disk_storage.get_tile_2d_path(t))
        
        return len(header_data) + len(body_data)
    

class BlockFile3D:
    def __init__(self, tile_disk_storage: TileDiskStorage, dataset: Dataset, parameter: str, lod: int, z: int, tile_format: str, index_mask_event_type: str = "") -> None:
        self.path = tile_disk_storage.get_block_file_3d_path(dataset, parameter, lod, z, tile_format) if not index_mask_event_type else tile_disk_storage.get_index_mask_block_file_path(dataset, parameter, index_mask_event_type, lod, z)
        self.block_contents = dataset.block_3d_contents_by_lod[lod]
        self.total_tiles = self.block_contents[0] * self.block_contents[1]
        self.block_sizes = []
        self.tile_format = tile_format
        # self.data = None

    def exists(self):
        return os.path.exists(self.path)

    def load_header(self):
        self.file = open(self.path, "rb")
        header_data = self.file.read(4 * self.total_tiles)
        for i in range(self.total_tiles):
            self.block_sizes.append(int.from_bytes(header_data[i*4:(i+1)*4], byteorder="little"))

    def get_tile_data(self, tiles: List[Tile3D]):
        total = bytearray()
        sizes = []
        header_offset = self.total_tiles * 4
        block_indices = []
        tiles_per_row = self.block_contents[0]
        # block_index_offset = sum([s[0] * s[1] for s in self.block_contents[:tiles[0].lod]]) # offset from previous LoDs, assumed LoD is the same throughout all tiles
        for tile in tiles:
            block_indices.append(tile.ty * tiles_per_row + tile.tx) # collect indices of all requested tiles
        
        group_function: Callable[[List[int]], int] = lambda indices: indices[0] - indices[1]
        for _, g in groupby(enumerate(block_indices), group_function): # group adjacent requested tiles to read them together
            group = list(map(itemgetter(1), g))
            my_byte_offset = header_offset + sum([s for s in self.block_sizes[:group[0]]])
            self.file.seek(my_byte_offset)
            for e in group:
                my_byte_size = self.block_sizes[e]
                total += self.file.read(my_byte_size)
                sizes.append(my_byte_size)
        return (sizes, total)

    @staticmethod
    def convert_intermediate_single_tile_files(tile_size: int, tile_disk_storage: TileDiskStorage, generation_cache: TileGenerationCache, dataset: Dataset, parameter: str, lod: int, z: int, tile_format: str):
        # tiles are in correct order already
        tiles: List[Tile3D] = Tile3D.get_tiles_in_range(tile_size, dataset, parameter, [z], lod)

        header_data = bytearray()
        body_data = bytearray()
        for t in tiles:
            tile_data = generation_cache.get_data(t)
            header_data += int.to_bytes(len(tile_data), 4, byteorder="little")
            body_data += tile_data

        with open(tile_disk_storage.get_block_file_3d_path(dataset, parameter, lod, z, tile_format), "wb") as file:
            file.write(header_data)
            file.write(body_data)

        if generation_cache.save_on_disk:
            for t in tiles:
                os.remove(tile_disk_storage.get_tile_3d_path(t))
        
        return len(header_data) + len(body_data)


