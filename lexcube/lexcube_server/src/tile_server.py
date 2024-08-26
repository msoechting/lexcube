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
import json
import math
import os
import shutil
import struct
import time
import bottleneck
from datetime import datetime
from itertools import groupby
import multiprocessing.pool
from operator import itemgetter
from typing import Iterable, List, Callable

from copy import deepcopy

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

DEFAULT_PRE_GENERATION_SPARSITY = 10
DEFAULT_PRE_GENERATION_THREADS = 4
NAN_TILE_MAGIC_NUMBER = -1
LOSSLESS_TILE_MAGIC_NUMBER = -2
API_VERSION = 5
TILE_VERSION = 2

TILE_FORMAT_MAGIC_BYTES = "lexc".encode("utf-8") # 6c 65 78 63, magic bytes to recognize lexcube tiles

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


# from: https://stackoverflow.com/a/2135920
def split_list_into_equal_parts(l: list, parts: int):
    k, m = divmod(len(l), parts)
    return ([l[i*k+min(i, m):(i+1)*k+min(i+1, m)]] for i in range(parts))

def print_current_memory_usage(s: str = ""):
    print(f"........................ [{s}] Current memory usage: {round(psutil.Process(os.getpid()).memory_info().rss / 1024 ** 2, 2)} MB")

class TileCompressor:
    def __init__(self, compress_lossless: bool) -> None:
        self.compress_lossless = compress_lossless
        self.tile_data_compressor_default = ZfpCompressor()
        self.tile_data_compressor_lossless = numcodecs.blosc.Blosc()
        self.nan_mask_compressor = numcodecs.lz4.LZ4(5)

    def set_tolerance(self, default_compression_tolerance: float, anomaly_compression_tolerance: float):
        self.default_compression_tolerance = default_compression_tolerance
        self.anomaly_compression_tolerance = anomaly_compression_tolerance

    def compress_nan_mask(self, nan_mask: bytes) -> bytes:
        return self.nan_mask_compressor.encode(nan_mask)
    
    def decompress_nan_mask(self, data: bytes) -> bytes:
        return self.nan_mask_compressor.decode(data)
    
    def get_tile_data_compressor(self, use_lossless_override: Union[bool, None] = None):
        lossless = self.compress_lossless if use_lossless_override == None else use_lossless_override
        if lossless:
            return self.tile_data_compressor_lossless
        else:
            return self.tile_data_compressor_default
    
    def compress_tile_data(self, tile_data: bytes, is_anomaly_tile: bool = False) -> bytes:
        if not self.compress_lossless:
            self.tile_data_compressor_default.tolerance = self.anomaly_compression_tolerance if is_anomaly_tile else self.default_compression_tolerance
        return self.get_tile_data_compressor().encode(tile_data)
        
    def decompress_tile_data(self, tile_data: bytes, use_lossless_override: Union[bool, None] = None) -> bytes:
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
    desired_max_lod = math.ceil(-math.log2(tile_size / max(dims)))
    largest_lod_possible = math.floor(math.log2(min(dims)))
    return min(desired_max_lod, largest_lod_possible)

# This function only works correctly if whole XY slices are passed into it, otherwise flipping Y will not give correct results
def patch_data(data: np.ndarray, dataset_id: str, parameter: str, dataset_config: DatasetConfig = None) -> np.ndarray:
    if dataset_id == "esdc-2.1.1-high-res" and parameter in ["sensible_heat", "terrestrial_ecosystem_respiration", "net_radiation", "net_ecosystem_exchange", "latent_energy", "gross_primary_productivity"]:
        data = np.where(data==-9999, np.nan, data) # Replace netcdf -9999(=NaN) values
    if parameter == "snow_water_equivalent":
        data = np.where(data==-1, np.nan, data) # -1 = Oceans = NaN
        data = np.where(data==-2, 0, data) # -2 = mountains or something...
    return data

def patch_dataset(ds: Union[xr.DataArray, xr.Dataset, np.ndarray]):
    if type(ds) == np.ndarray:
        return ds
    # Some datasets from xee (Google Earth Engine) have (time, lon, lat) dimension order, fix that here:
    dims = list(ds.dims)
    if dims[1] in LONGITUDE_DIMENSION_NAMES and dims[2] in LATITUDE_DIMENSION_NAMES:
        ds = ds.transpose(dims[0], dims[2], dims[1])
    # For data sets where the latitude is sorted by descending values (turning the world upside down), flip that:
    if dims[1] in LATITUDE_DIMENSION_NAMES:
        lat_values = ds[dims[1]]
        if lat_values[0] < lat_values[len(lat_values) - 1]:
            ds = ds.sortby(dims[1], ascending=False)
    return ds

def open_dataset(config: ServerConfig, path: str):
    aws_s3_hosted = path.startswith("s3://")
    http_hosted = path.startswith("http://")
    remote_hosted = aws_s3_hosted or http_hosted
    file_extension = path.split(".")[-1]
    protocol = path.split("://")[0]
    print(f"        > Opening {f'{protocol}-hosted' if remote_hosted else 'locally saved'} dataset ({path})")
    protocol_map = {
        "s3": fsspec.get_mapper(path, anon=True)
    }
    store = (protocol_map.get(protocol) or fsspec.get_mapper(path)) if remote_hosted else os.path.join(config.base_dir, path)
    engines = {
        "zarr": "zarr",
        "nc": "netcdf4"
    }
    ds = xr.open_dataset(store, engine=engines[file_extension])
    ds = patch_dataset(ds)
    return ds 

class DatasetConfig:
    def __init__(self, dataset_config: dict) -> None:
        self.id = str(dataset_config["id"])
        self.short_name = str(dataset_config["shortName"])
        self.dataset_path = str(dataset_config["datasetPath"])
        self.ignored_parameters: list[str] = list(dataset_config.get("ignoredParameters") or [])
        self.only_parameters: list[str] = list(dataset_config.get("onlyParameters") or [])
        self.pre_generation_sparsity = int(dataset_config.get("preGenerationSparsity") or DEFAULT_PRE_GENERATION_SPARSITY) 
        self.calculate_anomalies = bool(dataset_config.get("calculateYearlyAnomalies") or False)
        self.force_tile_generation = bool(dataset_config.get("forceTileGeneration") or False) 
        self.max_lod = int(dataset_config.get("overrideMaxLod") or -1) 
        self.use_offline_metadata = bool(dataset_config.get("useOfflineMetadata") or False) 
        self.min_max_values_approximate_only = bool(dataset_config.get("approximateMinMaxValues") or True) 

LONGITUDE_DIMENSION_NAMES = ["longitude","lon"]
LATITUDE_DIMENSION_NAMES = ["latitude","lat"]
TIME_DIMENSION_NAMES = ["time"]


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
        else:
            return np.datetime_as_string(data_array[dimension_name].values, timezone="UTC").tolist()
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


    def load_from_dataset(self, dataset: Dataset, data: xr.Dataset):
        self.dataset_dict = data.to_dict(data=False)
        
        dims = list(data[dataset.get_real_and_virtual_parameters()[0]].dims)
        self.x_dimension_name = dims[2]
        self.x_dimension_type = get_dimension_type(self.x_dimension_name)
        self.y_dimension_name = dims[1]
        self.y_dimension_type = get_dimension_type(self.y_dimension_name)
        self.z_dimension_name = dims[0]
        self.z_dimension_type = get_dimension_type(self.z_dimension_name)

        self.x_max = data.dims.get(self.x_dimension_name)
        self.y_max = data.dims.get(self.y_dimension_name)
        self.z_max = data.dims.get(self.z_dimension_name)
        
        self.axis_labels = {
            "x": get_dimension_labels(data, self.x_dimension_name, self.x_dimension_type),
            "y": get_dimension_labels(data, self.y_dimension_name, self.y_dimension_type),
            "z": get_dimension_labels(data, self.z_dimension_name, self.z_dimension_type)
        }

class ParameterMetadataParser:
    def __init__(self, config: ServerConfig, min_max_values_approximate_only: bool, dataset_path: str, dataset_id: str) -> None:
        self.min_max_values_approximate_only = min_max_values_approximate_only
        self.config = config
        self.dataset_path = dataset_path
        self.dataset_id = dataset_id        
        
    def discover_metadata_for_parameter(self, existing_metadata: ParameterMetadata, parameter: str):
        print(f"** parameter {parameter}")
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
        parameter_data = open_dataset(self.config, self.dataset_path)[parameter]
        if first == None or last == None:
            (first, last) = self.find_first_and_last_slices(parameter_data)
            print(f" - Detected first/last: {first} - {last}")
        if (minimum_value == None or maximum_value == None or median_of_1quantiles == None or median_of_99quantiles == None) or (min_max_approximate_only and not self.min_max_values_approximate_only):
            (minimum_value, maximum_value, median_of_1quantiles, median_of_99quantiles) = self.find_min_max_and_quantiles(parameter_data, self.dataset_id, parameter, first, last, self.min_max_values_approximate_only)
            min_max_approximate_only = self.min_max_values_approximate_only
            print(f" - Detected min/max: {minimum_value} - {maximum_value} Median 1%: {median_of_1quantiles} Median 99%: {median_of_99quantiles}")
        if resample_resolution == None:
            resample_resolution = self.detect_resample_resolution(parameter_data, self.dataset_id, parameter, first)
            print(f" - Detected resolution {resample_resolution}")
        # parameter_data = None
        # gc.collect()
        return ParameterMetadata(parameter, int(first), int(last), minimum_value, maximum_value, median_of_1quantiles, median_of_99quantiles, int(resample_resolution), min_max_approximate_only)

    def test_resample_resolution(self, data: np.ndarray, blocksize: int):
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
        slice = parameter_data[sample_time_slice].values
        for blocksize in range(32, 1, -1):
            if self.test_resample_resolution(slice, blocksize):
                return blocksize
        return 1

    def find_min_max_and_quantiles(self, parameter_data: xr.DataArray, dataset_id: str, parameter: str, first_time_slice: int, last_time_slice: int, approximate_only: bool = False):
        step = max(1, math.floor((last_time_slice - first_time_slice + 1) / 150.0)) if approximate_only else 1
        minimum_value = np.Infinity
        maximum_value = -np.Infinity
        observations = 0
        local_1quantiles = []
        local_99quantiles = []
        
        print(f"Find min, max and quantile values {'[approximate only]' if approximate_only else ''} - ", end="", flush=True)
        for t in range(first_time_slice, last_time_slice, step):
            observations += 1
            values = patch_data(parameter_data[t].values, dataset_id, parameter)
            mask = np.abs(values) != np.inf
            local_min = np.nanmin(values[mask], initial=minimum_value)
            local_max = np.nanmax(values[mask], initial=maximum_value)
            local_1quantile = np.nanquantile(values[mask], 0.01, method="closest_observation")
            local_99quantile = np.nanquantile(values[mask], 0.99, method="closest_observation")

            minimum_value = min(minimum_value, local_min)
            maximum_value = max(maximum_value, local_max)
            if local_1quantile != np.nan:
                local_1quantiles.append(local_1quantile)
            if local_99quantile != np.nan:
                local_99quantiles.append(local_99quantile)

        median_of_1quantiles = np.nanmedian(local_1quantiles)
        median_of_99quantiles = np.nanmedian(local_99quantiles)

        # if any of the values are NaN, write error to print
        if np.isnan(minimum_value) or np.isnan(maximum_value) or np.isnan(median_of_1quantiles) or np.isnan(median_of_99quantiles):
            print(f"Warning: NaN values detected in min/max/quantile calculations for {parameter} - {minimum_value} - {maximum_value} - {median_of_1quantiles} - {median_of_99quantiles}, setting to min/max to 0 if nan and medians to min/max if nan.")
            if np.isnan(minimum_value):
                minimum_value = 0
            if np.isnan(maximum_value):
                maximum_value = 0
            if np.isnan(median_of_1quantiles):
                median_of_1quantiles = minimum_value
            if np.isnan(median_of_99quantiles):
                median_of_99quantiles = maximum_value

        # print(f"Min: {minimum_value} Max: {maximum_value} Accesses: {accesses}")
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
        # Find first time slice
        lower_hint = 0
        upper_hint = z_max - 1
        done = False
        for step in steps:
            for time in range(0, z_max, max(step, 1)):
                accesses += 1
                if not np.all(np.isnan(parameter_data[time].values)):
                    upper_hint = time
                    done = True
                    # print(f"1st loop - found something at {time}")
                    break
                lower_hint = time
            if done:
                break
        # print(f"Got hints for first found value: {lower_hint} - {upper_hint}")
        for time in range(lower_hint, upper_hint + 1):
            accesses += 1
            if not np.all(np.isnan(parameter_data[time].values)):
                first_found = time
                # print(f"2nd loop - found something at {time}")
                break
        # print(f"First: {first_found}")

        # Find last time slice
        lower_hint = 0
        upper_hint = z_max - 1
        done = False
        for step in steps:
            for time in reversed(range(0, z_max, max(step, 1))):
                accesses += 1
                if not np.all(np.isnan(parameter_data[time].values)):
                    lower_hint = time
                    done = True
                    # print(f"1st loop - found something at {time}")
                    break
                upper_hint = time
            if done:
                break
        # print(f"Got hints for last found value: {lower_hint} - {upper_hint}")
        for time in reversed(range(lower_hint, upper_hint + 1)):
            accesses += 1
            if not np.all(np.isnan(parameter_data[time].values)):
                last_found = time
                # print(f"2nd loop - found something at {time}")
                break        
        # naive = first_found + (time_max - last_found - 1)
        # print(f"First: {first_found} Last: {last_found} Accesses: {accesses} (naive: {naive}, {format((accesses * 100.0 / (naive + 0.01)), '.2f')}%)")
        return (first_found, last_found)

class Dataset:
    def __init__(self, server_config: ServerConfig, dataset_config: dict, base_dir: str, tile_size: int) -> None:
        self.dataset_config = DatasetConfig(dataset_config)
        self.id = self.dataset_config.id
        self.short_name = self.dataset_config.short_name
        self.base_dir = base_dir
        self.data: xr.Dataset = None
        self.calculate_anomalies: bool = self.dataset_config.calculate_anomalies
        self.force_tile_generation: bool = self.dataset_config.force_tile_generation
        self.all_valid_parameters: list[str] = []
        self.real_parameters: list[str] = []
        self.virtual_parameters: list[str] = []
        self.parameter_block_list = self.dataset_config.ignored_parameters
        self.parameter_allow_list = self.dataset_config.only_parameters
        self.parameter_metadata: dict[str, ParameterMetadata] = {}
        self.block_contents = []
        self.pre_generation_sparsity = self.dataset_config.pre_generation_sparsity
        self.max_lod = self.dataset_config.max_lod
        self.min_max_values_approximate_only = self.dataset_config.min_max_values_approximate_only
        self.server_config = server_config
        self.x_max = -1
        self.y_max = -1
        self.z_max = -1
        self.tile_size = tile_size
        self.use_offline_metadata = self.dataset_config.use_offline_metadata
        self.meta_data = DatasetMetadata()

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
            self.meta_data.load_from_dataset(self, self.data)
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
        result["max_lod"] = self.max_lod
        result["sparsity"] = self.pre_generation_sparsity
        return result

    def get_real_and_virtual_parameters(self):
        all_parameters = self.meta_data.get_all_parameters()
        virtual_parameters = []
        if len(self.parameter_allow_list) > 0:
            valid_parameters = [p for p in all_parameters if p in self.parameter_allow_list]
        else:
            valid_parameters = [p for p in all_parameters if p not in self.parameter_block_list]
        valid_parameters = [p for p in valid_parameters if len(self.meta_data.dataset_dict["data_vars"][p]["shape"]) == 3]
        # if len(valid_parameters) != len(all_parameters):
        #     print(f"Skipping parameters: [{', '.join([p for p in all_parameters if p not in valid_parameters])}]")  
        if self.calculate_anomalies:
            virtual_parameters.extend([p + ANOMALY_PARAMETER_ID_SUFFIX for p in valid_parameters])
        return (valid_parameters, virtual_parameters)

    def open(self, tile_directory):
        if not self.use_offline_metadata:
            self.data = open_dataset(self.server_config, self.dataset_config.dataset_path)
        self.load_metadata(tile_directory)
        self.real_parameters, self.virtual_parameters = self.get_real_and_virtual_parameters()
        print(f"        > Real parameters: [{', '.join([p for p in self.real_parameters])}]")  
        print(f"        > Virtual parameters: [{', '.join([p for p in self.virtual_parameters])}]")  
        self.all_valid_parameters = self.real_parameters + self.virtual_parameters
        if self.max_lod == -1: # i.e. max lod was not set in config
            desired_max_lod = math.ceil(-math.log2(self.tile_size / max([self.meta_data.z_max, self.meta_data.y_max, self.meta_data.x_max])))
            largest_lod_possible = math.floor(math.log2(min([self.meta_data.z_max, self.meta_data.y_max, self.meta_data.x_max])))
            self.max_lod = min(desired_max_lod, largest_lod_possible)

    def generate_block_indices(self, tile_server):
        self.block_contents = []
        for index_dimension in Dimension:
            width = self.x_max if index_dimension == Dimension.Z or index_dimension == Dimension.Y else self.y_max
            height = self.y_max if index_dimension == Dimension.Z else self.meta_data.z_max

            content_info = []
            for lod in range(0, self.max_lod + 1):
                lod_factor = pow(0.5, lod)
                adjusted_width = lod_factor * width
                adjusted_height = lod_factor * height
                x_tiles = math.ceil(adjusted_width / tile_server.TILE_SIZE)
                y_tiles = math.ceil(adjusted_height / tile_server.TILE_SIZE)
                content_info.append((x_tiles, y_tiles))
            self.block_contents.append(content_info)

class ServerConfig:
    def __init__(self, tile_size) -> None:
        self.datasets = {}
        self.tile_cache_directory = ""
        self.tile_size = tile_size
        self.pre_generation_threads = 0

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
                self.datasets[dataset_config["id"]] = Dataset(self, dataset_config, self.base_dir, self.tile_size)

class TileDiskStorage:
    def __init__(self, directory: str, datasets: dict[str, Dataset]) -> None:
        self.directory = directory
        self.datasets = datasets

    def try_migrate_dimension_folders(self, dataset: Dataset):
        old_names = ["Time", "Latitude", "Longitude"]
        first = True
        for param in dataset.all_valid_parameters:
            lookup_dir = os.path.join(self.directory, dataset.id, param)
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
                source = os.path.join(self.directory, dataset.id, param, old_name)
                destination = os.path.join(self.directory, dataset.id, param, new_name)
                shutil.move(source, destination)
        
    def get_block_path(self, dataset: Dataset, parameter: str, index_dimension: Dimension, indexValue: int):
        return os.path.join(self.directory, dataset.id, parameter, dataset.get_dimension_name(index_dimension), f"{indexValue}")

    def get_tile_path(self, tile: Tile):
        return os.path.join(self.directory, tile.dataset_id, tile.parameter, self.datasets[tile.dataset_id].get_dimension_name(tile.index_dimension), f"{tile.index_value}.{tile.lod}.{tile.x}.{tile.y}")
    
class TileMemoryCache:
    def __init__(self) -> None:
        self.cache = {}

    def tile_exists(self, tile: Tile):
        return tile.get_hash_key() in self.cache
    
    def put_data(self, tile: Tile, data):
        self.cache[tile.get_hash_key()] = data

    def get_data(self, tile: Tile):
        return self.cache[tile.get_hash_key()]

class ParameterMetadata:
    def __init__(self, name: str, first_valid_time_slice: int = None, last_valid_time_slice: int = None, minimum_value: float = None, maximum_value: float = None, median_of_1quantiles: float = None, median_of_99quantiles: float = None, resample_resolution: int = None, min_max_values_approximate_only: bool = False) -> None:
        self.name = name
        self.first_valid_time_slice = first_valid_time_slice
        self.last_valid_time_slice = last_valid_time_slice
        self.minimum_value = minimum_value
        self.maximum_value = maximum_value
        self.median_of_1quantiles = median_of_1quantiles
        self.median_of_99quantiles = median_of_99quantiles
        self.resample_resolution = resample_resolution
        self.min_max_values_approximate_only = min_max_values_approximate_only

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

class Tile:
    @staticmethod
    def get_tiles_in_range(tile_size: int, dataset: Dataset, parameter: str, index_dimension: Dimension, index_values: Iterable, lods: Iterable) -> List[Tile]:
        width = dataset.x_max if index_dimension == Dimension.Z or index_dimension == Dimension.Y else dataset.y_max
        height = dataset.y_max if index_dimension == Dimension.Z else dataset.z_max

        tiles = []
        for index_value in index_values:
            for lod in lods:
                lod_factor = pow(0.5, lod)
                adjusted_width = lod_factor * width
                adjusted_height = lod_factor * height
                x_tiles = math.ceil(adjusted_width / tile_size)
                y_tiles = math.ceil(adjusted_height / tile_size)
                for y in range(y_tiles):
                    for x in range(x_tiles):
                        tiles.append(Tile(tile_size, dataset.id, parameter, index_dimension, index_value, lod, x, y))
        return tiles

    def __init__(self, tile_size: int, dataset_id: str, parameter: str, index_dimension: Dimension, index_value: int, lod: int, x: int, y: int, is_anomaly_tile: bool = False) -> None:
        self.tile_size = tile_size
        self.dataset_id = dataset_id
        self.parameter = parameter
        self.index_dimension = index_dimension
        self.index_value = index_value
        self.lod = lod
        self.x = x
        self.y = y
        self.is_anomaly_tile = is_anomaly_tile
        self.data = None

    def get_anomaly_tile(self):
        return Tile(self.tile_size, self.dataset_id, self.parameter + ANOMALY_PARAMETER_ID_SUFFIX, self.index_dimension, self.index_value, self.lod, self.x, self.y, True)
    
    def get_hash_key(self):
        return "-".join([self.dataset_id, self.parameter, str(self.index_dimension.value), str(self.index_value), str(self.lod), str(self.x), str(self.y)])

    def generate_from_data(self, source_data: Union[xr.DataArray, np.ndarray, DataSourceProxy], tile_compressor: TileCompressor, z_offset: int = 0, added_compression_error: float = 0.0, resample_resolution: int = 1, compress_lossless: bool = False):
        lod_factor = pow(2, self.lod)
        inverse_lod_factor = 1 / lod_factor
        lod_tile_size = lod_factor * self.tile_size
        lat_tile_index = self.x if self.index_dimension == Dimension.X else self.y

        z_slice = slice(lod_factor * (self.y * self.tile_size - z_offset), lod_factor * ((self.y + 1) * self.tile_size - z_offset))
        y_slice = slice(lod_tile_size * lat_tile_index, lod_tile_size * (lat_tile_index + 1))
        x_slice = slice(lod_tile_size * self.x, lod_tile_size * (self.x + 1))

        if len(source_data.shape) == 3:
            if self.index_dimension == Dimension.Z:
                data_values = source_data[self.index_value - z_offset, y_slice, x_slice]
            elif self.index_dimension == Dimension.Y:
                data_values = source_data[z_slice, self.index_value, x_slice]
            elif self.index_dimension == Dimension.X:
                data_values = source_data[z_slice, y_slice, self.index_value]
        elif len(source_data.shape) == 2:
            if self.index_dimension == Dimension.Z:
                data_values = source_data[y_slice, x_slice]
            elif self.index_dimension == Dimension.Y:
                data_values = source_data[z_slice, x_slice]
            elif self.index_dimension == Dimension.X:
                data_values = source_data[z_slice, y_slice]

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
                data_values = cv2.resize(v, None, fx=inverse_lod_factor, fy=inverse_lod_factor, interpolation=cv2.INTER_LINEAR)
        
        adjusted_resample_resolution = max(1, resample_resolution * inverse_lod_factor)
        if (resample_resolution * inverse_lod_factor) % 1 != 0: 
            adjusted_resample_resolution = 1 # Resolutions that are not a whole number are not yet supported
        adjusted_resample_resolution = int(adjusted_resample_resolution)
        if adjusted_resample_resolution > 1:
            # Pad the data if there is the edge case of an irregular resample at the beginning and the end of the block, for x/y respectively
            resample_x_offset_start = adjusted_resample_resolution - ((self.x * self.tile_size) % adjusted_resample_resolution)
            resample_y_offset_start = adjusted_resample_resolution - ((self.y * self.tile_size) % adjusted_resample_resolution)
            resample_x_offset_end = (self.tile_size - resample_x_offset_start) % adjusted_resample_resolution
            resample_y_offset_end = (self.tile_size - resample_y_offset_start) % adjusted_resample_resolution
            if resample_x_offset_start > 0 and resample_x_offset_end > 0 and resample_x_offset_start + resample_x_offset_end < adjusted_resample_resolution:
                data_values = np.hstack((data_values, np.broadcast_to(data_values[:,-1][:,None], (data_values.shape[0], adjusted_resample_resolution - 1))))
            if resample_y_offset_start > 0 and resample_y_offset_end > 0 and resample_y_offset_start + resample_y_offset_end < adjusted_resample_resolution:
                data_values = np.vstack((data_values, np.broadcast_to(data_values[-1,:][None,:], (adjusted_resample_resolution - 1, data_values.shape[1]))))
            data_values = data_values[::adjusted_resample_resolution,::adjusted_resample_resolution]

        return self.compress_data(data_values, tile_compressor, adjusted_resample_resolution, added_compression_error)

    def exists_as_intermediate_single_file(self, path: str):
        return os.path.exists(path)

    def read_from_intermediate_single_file(self, path: str, suffix = ""):
        file = open(path + suffix, "rb")
        return file.read()

    def write_to_intermediate_single_file(self, path: str, compressed_data: bytes, suffix = ""):
        with open(path + suffix, "wb") as f:
            f.write(compressed_data)

    def get_tile_metadata_bytes(self, resample_resolution: int, nan_mask_length: int, max_error_or_magic_number: float):
        return TILE_FORMAT_MAGIC_BYTES + struct.pack("<I", TILE_VERSION) + struct.pack("<I", resample_resolution) + struct.pack("<I", nan_mask_length) + struct.pack("<d", max_error_or_magic_number)        
    
    def compress_data(self, source_values: Union[xr.DataArray, np.ndarray], tile_compressor: TileCompressor, resample_resolution: int = 1, added_compression_error: float = 0.0):
        if np.all(np.isnan(source_values)):
            return self.get_tile_metadata_bytes(0, 0, NAN_TILE_MAGIC_NUMBER)
        # if np.any(np.isnan(source_values)):
        #     print("yes")
        tile_data = np.full((self.tile_size, self.tile_size), np.nan, np.float64)
        tile_data[:source_values.shape[0], :source_values.shape[1]] = source_values

        nan_mask = np.full((self.tile_size, self.tile_size), 0, np.float32)
        nan_mask[np.isnan(tile_data)] = np.nan

        statistical_data_bytes = struct.pack("<d", np.nanmin(source_values)) + struct.pack("<d", np.nanmax(source_values)) + struct.pack("<d", np.nanmean(source_values)) + struct.pack("<d", np.nanvar(source_values))

        if tile_compressor.compress_lossless:
            compressed_tile_data = tile_compressor.compress_tile_data(tile_data)
            return self.get_tile_metadata_bytes(resample_resolution, 0, LOSSLESS_TILE_MAGIC_NUMBER) + statistical_data_bytes + compressed_tile_data

        np.nan_to_num(tile_data, copy=False)
        compressed_nan_mask = tile_compressor.compress_nan_mask(nan_mask)
        compressed_tile_data = tile_compressor.compress_tile_data(tile_data, self.is_anomaly_tile)
        decompressed_tile_data = tile_compressor.decompress_tile_data(compressed_tile_data)
        errors = np.abs(decompressed_tile_data[:source_values.shape[0], :source_values.shape[1]] - source_values)
        max_error = np.nanmax(errors, initial=0) + added_compression_error
        return self.get_tile_metadata_bytes(resample_resolution, len(compressed_nan_mask), max_error) + statistical_data_bytes + compressed_nan_mask + compressed_tile_data

    def decompress(self, data: bytes, tile_compressor: TileCompressor) -> tuple:
        tile_format = data[:4]
        if tile_format != TILE_FORMAT_MAGIC_BYTES:
            raise Exception("Invalid tile format")
        tile_version = struct.unpack("<i", data[4:8])[0]
        if tile_version != TILE_VERSION:
            raise Exception("Invalid tile version")
        max_compression_error_or_magic_number = struct.unpack("<d", data[16:24])[0]
        if max_compression_error_or_magic_number == NAN_TILE_MAGIC_NUMBER:
            return (np.full((self.tile_size, self.tile_size), np.nan), 0.0)
        resample_resolution = struct.unpack("<I", data[8:12])[0]
        if resample_resolution != 1:
            print("Warning, non-1 resample resolution found during decompression. This case is not implemented")
        if max_compression_error_or_magic_number == LOSSLESS_TILE_MAGIC_NUMBER:
            tile_data = np.frombuffer(tile_compressor.decompress_tile_data(data[56:], True), np.float64).reshape((self.tile_size, self.tile_size))
            return (tile_data, 0.0)
        nan_mask_length = struct.unpack("<I", data[12:16])[0]
        nan_mask_compressed = data[56:56+nan_mask_length]
        nan_mask_bytes = tile_compressor.decompress_nan_mask(nan_mask_compressed)
        nan_mask = np.frombuffer(nan_mask_bytes, np.float32).reshape((self.tile_size, self.tile_size))
        tile_data = tile_compressor.decompress_tile_data(data[56+nan_mask_length:], False) + nan_mask
        return (tile_data, max_compression_error_or_magic_number)

    def get_values_from_cache(self, generation_cache: TileGenerationCache, tile_compressor: TileCompressor) -> tuple:
        return self.decompress(generation_cache.get_data(self), tile_compressor)

    def __str__(self):
        return f"{self.dataset_id} / {self.parameter} / Index: {self.index_dimension.name}, {self.index_value} / LoD: {self.lod} / XY: {self.x},{self.y}"
        
class TileGenerationCache:
    def __init__(self, tile_disk_storage: TileDiskStorage, save_on_disk=False) -> None:
        # By default, intermediate tiles are generated in memory. 
        # If that is not feasible, they can be saved on disk instead (passing True to the "save_on_disk" argument)
        self.save_on_disk = save_on_disk
        self.tile_disk_cache = tile_disk_storage
        self.cache = {}

    def tile_exists(self, tile: Tile):
        if self.save_on_disk:
            return tile.exists_as_intermediate_single_file(self.tile_disk_cache.get_tile_path(tile))
        else:
            return tile.get_hash_key() in self.cache
    
    def put_data(self, tile: Tile, data):
        if self.save_on_disk:
            tile.write_to_intermediate_single_file(self.tile_disk_cache.get_tile_path(tile), data)
        else:
            self.cache[tile.get_hash_key()] = data

    def get_data(self, tile: Tile):
        if self.save_on_disk:
            return tile.read_from_intermediate_single_file(self.tile_disk_cache.get_tile_path(tile))
        else:
            return self.cache[tile.get_hash_key()]

    def put_uncompressed_data(self, tile: Tile, data):
        if self.save_on_disk:
            tile.write_to_intermediate_single_file(self.tile_disk_cache.get_tile_path(tile), data, UNCOMPRESSED_SUFFIX)
        else:
            self.cache[tile.get_hash_key() + UNCOMPRESSED_SUFFIX] = data

    def get_uncompressed_data(self, tile: Tile):
        if self.save_on_disk:
            return tile.read_from_intermediate_single_file(self.tile_disk_cache.get_tile_path(tile), UNCOMPRESSED_SUFFIX)
        else:
            return self.cache[tile.get_hash_key() + UNCOMPRESSED_SUFFIX]
        
    def clear(self):
        if self.save_on_disk:
            self.tile_disk_cache.clear()
        else:
            self.cache.clear()

class ZfpCompressor:
    def __init__(self) -> None:
        self.tolerance = -1
        self.rate = -1
        self.precision = -1

    def encode(self, data):
        import zfpy
        return zfpy.compress_numpy(data, self.tolerance, self.rate, self.precision)

    def decode(self, data):
        import zfpy
        return zfpy.decompress_numpy(data)

class TileServer:
    def __init__(self, widget_mode = False) -> None:
        self.compress_lossless = widget_mode
        self.TILE_SIZE = 256
        self.config = ServerConfig(self.TILE_SIZE)
        self.tile_disk_storage = None
        self.datasets: dict[str, Dataset] = {}
        self.ignore_tile_cache = False
        self.forbid_runtime_tile_generation = False
        self.widget_mode = widget_mode
        self.tile_compressor = TileCompressor(self.compress_lossless)
        self.next_request_id = 0
        self.next_request_group_id = 0
        self.request_progress = {}
    

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
        self.data_source_proxy = DataSourceProxy(self.data_source)
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
            c.generate_block_indices(self)
        print("* Finished opening datasets")

        self.tile_disk_storage = TileDiskStorage(os.path.join(self.config.tile_cache_directory, f"tile_version_{TILE_VERSION}", str(self.TILE_SIZE)), self.datasets)
        os.makedirs(self.config.tile_cache_directory, exist_ok=True)

        for dataset in self.datasets.values():
            try:
                self.tile_disk_storage.try_migrate_dimension_folders(dataset)
            except:
                pass
            self.discover_metadata_for_all_parameters(dataset)


        print("* Startup finished.")

    def discover_metadata_for_all_parameters(self, dataset: Dataset):
        if self.try_read_metadata(dataset):
            return
        threads = self.config.pre_generation_threads
        print(f"Discover metadata for dataset {dataset.id} (using {threads} threads)")
        metadata = {}
        with multiprocessing.Pool(threads) as pool:
            metadatas = pool.starmap(ParameterMetadataParser(self.config, dataset.min_max_values_approximate_only, dataset.dataset_config.dataset_path, dataset.id).discover_metadata_for_parameter, [(dataset.parameter_metadata.get(p), p) for p in dataset.real_parameters])
            for m in metadatas:
                metadata[m.name] = m.to_dict()
        metadata_file_path = os.path.join(self.config.tile_cache_directory, f"discovered_metadata-{dataset.id}.json")
        with open(metadata_file_path, "w") as f:
            json.dump(metadata, f)
        self.try_read_metadata(dataset)

    def try_read_metadata(self, dataset: Dataset):
        metadata_file_path = os.path.join(self.config.tile_cache_directory, f"discovered_metadata-{dataset.id}.json")
        if not os.path.exists(metadata_file_path):
            return False
        json_data = json.load(open(metadata_file_path, "r"))
        complete = True
        for parameter in json_data:
            dataset.parameter_metadata[parameter] = ParameterMetadata(parameter).from_dict(json_data[parameter])
            if not dataset.parameter_metadata[parameter].is_complete() or (not dataset.min_max_values_approximate_only and dataset.parameter_metadata[parameter].min_max_values_approximate_only):
                complete = False
        for parameter in dataset.real_parameters:
            if dataset.parameter_metadata.get(parameter) == None:
                complete = False
                break
        return complete
    
    def pre_register_requests(self, requests):
        request_group_id = self.next_request_group_id
        self.next_request_group_id += 1
        for request in requests:
            request["request_id"] = self.next_request_id
            request["request_group_id"] = request_group_id
            self.update_progress(request_group_id, request["request_id"], 0, len(request["xys"]))
            self.next_request_id += 1
    
    def handle_tile_request_widget(self, request):
        request_id = request["request_id"]
        request_group_id = request["request_group_id"]
        index_dimension = dimension_mapping[request["indexDimension"]]
        index_value = request["indexValue"]
        lod = request["lod"]
        xys = request["xys"]
        before = time.perf_counter()

        data = bytearray()
        sizes = []
        tiles_generated = 0
        cache_hits = 0
        # with self.register_progress(request_id, len(xys)):
        for xy in xys:
            t = Tile(self.TILE_SIZE, "", "", index_dimension, index_value, lod, xy[0], xy[1])
            tile_cached = self.tile_memory_cache.tile_exists(t)
            if tile_cached:
                cache_hits += 1
                d = self.tile_memory_cache.get_data(t)
            else:
                d = t.generate_from_data(self.data_source_proxy if self.use_data_source_proxy else self.data_source, self.tile_compressor)
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
        dataset_id = request_data["datasetId"]
        parameter = request_data["parameter"]
        index_dimension = dimension_mapping[request_data["indexDimension"]]
        index_value = request_data["indexValue"]
        lod = request_data["lod"]
        xys = request_data["xys"]
        dataset = self.datasets.get(dataset_id)
        if not (dataset and parameter in self.datasets[dataset_id].all_valid_parameters):
            return print(f"Dataset id or parameter not found ({dataset_id} / {parameter})")
        if (index_value % dataset.pre_generation_sparsity) != 0:
            return print(f"Bad request for index value {index_value} in {index_dimension.name}")
        
        tiles = []
        for xy in xys:
            tiles.append(Tile(self.TILE_SIZE, dataset, parameter, index_dimension, index_value, lod, xy[0], xy[1]))

        blockfile = BlockFile(self.tile_disk_storage, dataset, parameter, index_dimension, index_value)
        blockfile.load_header()
        (sizes, data) = blockfile.get_tile_data(tiles)

        if blockfile.exists() and not self.ignore_tile_cache:
            await socketio.emit("tile_data", { "metadata": request_data, "dataSizes": sizes, "data": bytes(data) }, to=sender_id)
        else:
            if self.forbid_runtime_tile_generation:
                print(f"Forbid generation of tile {request_data}")
                return
            # await sio.emit("tile_data", { "metadata": r, "data": tile.generate_then_read() }, to=sender_id)

class BlockFile:
    def __init__(self, tile_disk_storage: TileDiskStorage, dataset: Dataset, parameter: str, index_dimension: Dimension, index_value: int) -> None:
        self.path = tile_disk_storage.get_block_path(dataset, parameter, index_dimension, index_value)
        self.block_contents = dataset.block_contents[index_dimension.value]
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

    def get_tile_data(self, tiles: List[Tile]):
        total = bytearray()
        sizes = []
        header_offset = self.total_tiles * 4
        block_index_offset = sum([s[0] * s[1] for s in self.block_contents[:tiles[0].lod]]) # offset from previous LoDs, assumed LoD is the same throughout all tiles
        block_indices = []
        for tile in tiles:
            block_indices.append(block_index_offset + tile.y * self.block_contents[tile.lod][0] + tile.x) # collect indices of all requested tiles
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
        tiles: List[Tile] = Tile.get_tiles_in_range(tile_size, dataset, parameter, index_dimension, [index_value], range(0, dataset.max_lod + 1))
        
        header_data = bytearray()
        body_data = bytearray()
        for t in tiles:
            tile_data = generation_cache.get_data(t)
            header_data += int.to_bytes(len(tile_data), 4, byteorder="little")
            body_data += tile_data

        with open(tile_disk_storage.get_block_path(dataset, parameter, index_dimension, index_value), "wb") as file:
            file.write(header_data)
            file.write(body_data)

        if generation_cache.save_on_disk:
            for t in tiles:
                os.remove(tile_disk_storage.get_tile_path(t))
        
        return len(header_data) + len(body_data)
