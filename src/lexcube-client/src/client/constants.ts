/*
    Lexcube - Interactive 3D Data Cube Visualization
    Copyright (C) 2022 Maximilian Söchting <maximilian.soechting@uni-leipzig.de>

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation; either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { DataUtils } from "three";


enum CubeFace {
    Front = 0,
    Back = 1,
    Top = 2,
    Bottom = 3,
    Left = 4,
    Right = 5,
}

enum Dimension {
    X = 0,
    Y = 1,
    Z = 2,
}

enum DeviceOrientation {
    Landscape = 0,
    Portrait = 1,
}

enum DataType {
    Float,
    HalfFloat,
    RGB
}

enum TileRequestIntention {
    Visualization = 0,
    ParseForTimeSeries = 1
}

enum RaycastResultType {
    Background,
    Cube,
    ContextLayer,
}

function getIndexDimensionOfFace(face: CubeFace) {
    return (face <= 1 ? Dimension.Z : (face <= 3 ? Dimension.Y : Dimension.X));
}

function getFacesOfIndexDimension(dimension: Dimension) {
    return [[CubeFace.Left, CubeFace.Right], [CubeFace.Top, CubeFace.Bottom], [CubeFace.Front, CubeFace.Back]][dimension];
}

function getAddressedFacesOfDimension(dimension: Dimension) {
    return [[CubeFace.Top, CubeFace.Bottom, CubeFace.Front, CubeFace.Back], [CubeFace.Left, CubeFace.Right, CubeFace.Front, CubeFace.Back], [CubeFace.Left, CubeFace.Right, CubeFace.Top, CubeFace.Bottom]][dimension];
}

function positiveModulo(i: number, n: number) {
    return (i % n + n) % n;
}

// Range with end inclusive
function range(start: number, end: number) {
    return Array.apply(0, Array(end - start + 1)).map((element, index) => index + start);
}


function saveFloatArrayAsPNG(data: Float32Array | Float64Array, width: number, height: number, colormapMinimumValue: number, colormapMaximumValue: number, filename: string): void {
    // Create a canvas element
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
  
    // Create an ImageData object from the Float32Array
    const imageData = ctx.createImageData(width, height);
    const uint8Data = new Uint8ClampedArray(data.length * 4);
  
    // Convert Float32Array values to RGBA format
    for (let i = 0; i < data.length; i++) {
      const value = Math.floor((data[i] - colormapMinimumValue) / (colormapMaximumValue - colormapMinimumValue) * 255);
      const index = i * 4;
      let r = value;
      let g = value;
      let b = value;
      if (data[i] == FLOAT_NAN_REPLACEMENT_VALUE) {
          r = 0;
          g = 0;
          b = 255;
      }
      uint8Data[index] = r;     // R
      uint8Data[index + 1] = g; // G
      uint8Data[index + 2] = b; // B
      uint8Data[index + 3] = 255;   // A (fully opaque)
    }
  
    imageData.data.set(uint8Data);
  
    // Put the image data on the canvas
    ctx.putImageData(imageData, 0, 0);
  
    // Convert the canvas to a data URL
    const dataURL = canvas.toDataURL('image/png');
  
    // Create a download link and trigger the download
    const link = document.createElement('a');
    link.href = dataURL;
    link.download = filename;
    link.click();
}



function capitalizeString(s: string) {
    return s[0].toUpperCase() + s.slice(1);
}

function roundToSparsity(value: number, sparsity: number) {
    return Math.round(value / sparsity) * sparsity;
}

function roundUpToSparsity(value: number, sparsity: number) {
    return Math.ceil(value / sparsity) * sparsity;
}

function roundDownToSparsity(value: number, sparsity: number) {
    return Math.floor(value / sparsity) * sparsity;
}

function roundToSparsityWithinRange(value: number, sparsity: number, min: number, max: number) {
    return Math.min(roundDownToSparsity(max, sparsity), Math.max(roundUpToSparsity(min, sparsity), roundToSparsity(value, sparsity)));
}

const debounceLastCallTimes = new Map<string, number>();

// Debounce-style function with immediate call and guaranteed trailing call
// - Calls the callback immediately if not called in the last `wait` ms, otherwise schedule a call exactly at `wait` ms after the last call
function debounce<T extends (...args: any[]) => void>(
  wait: number,
  callback: T,
  key: string = callback.toString() // use callback's string representation as default key for tracking last call time
) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let lastCallTime = debounceLastCallTimes.get(key) || 0;

  return function <U>(this: U, ...args: Parameters<T>) {
    const now = Date.now();
    const context = this;
    const timeSinceLastCall = now - lastCallTime;

    const callCallback = () => {
      debounceLastCallTimes.set(key, Date.now());
      timeout = null;
      callback.apply(context, args);
    };

    if (timeSinceLastCall >= wait || lastCallTime === 0) {
      // Call immediately when no call in last wait ms
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      callCallback();
    } else {
      // Schedule a trailing call exactly at wait ms after last callback
      if (timeout) {
        clearTimeout(timeout);
      }
      const timeLeft = wait - timeSinceLastCall;
      timeout = setTimeout(callCallback, timeLeft);
    }
  };
}



const WATER_RELATED_VARIABLE_KEYWORDS = ["transpiration", "evaporation", "ice", "humidity", "soil water", "precipitation"]

const TILE_SIZE_2D = 256;
const TILE_SIZE_3D = 256;
const MAX_ZOOM_FACTOR = 6.0;
const TILE_FORMAT_MAGIC_BYTES = "lexc";
const ANOMALY_PARAMETER_ID_SUFFIX = "_lxc_anomaly";
const NAN_TILE_MAGIC_NUMBER = -1;
const LOSSLESS_TILE_MAGIC_NUMBER = -2;
const FLOAT_NAN_REPLACEMENT_VALUE = -9992.0;
const FLOAT_NOT_LOADED_REPLACEMENT_VALUE = -10000.0;
const HALF_FLOAT_NAN_REPLACEMENT_VALUE = DataUtils.toHalfFloat(FLOAT_NAN_REPLACEMENT_VALUE);
const HALF_FLOAT_NOT_LOADED_REPLACEMENT_VALUE = DataUtils.toHalfFloat(FLOAT_NOT_LOADED_REPLACEMENT_VALUE);
const RGB_NAN_ALPHA_VALUE = 0;
const RGB_NOT_LOADED_ALPHA_VALUE = 127;
const COLORMAP_STEPS = 1024;
const DEFAULT_COLORMAP = "viridis";
const NON_EXTREME_QUANTILE_INDEX = 20;
const QUANTILE_STEP = 0.01;
const QUANTILE_RELEVANT_DECIMALS = 2;
const NAN_FACTOR_MASK_VALID_VALUE = 255;
const NAN_FACTOR_MASK_NAN_VALUE = 0;

const TILES_TEXTURE_NAME = "tilesLod";
const QUANTILE_INDEX_AND_NAN_FACTOR_MASK_TEXTURE_NAME = "quantileIndexAndNanFactorMaskLod";

const MAXIMUM_SUPPORTED_LOD = 6; // 6 is maximum for 3d, otherwise shader does not compile (max texture units)

const INVALID_LOD_PLACEHOLDER = -1;

const DEFAULT_FOV: number = 40;
const ORTHOGRAPHIC_MIN_ZOOM = 1;
const ORTHOGRAPHIC_MAX_ZOOM = 1.8;
const PERSPECTIVE_MIN_DISTANCE = 3;
const PERSPECTIVE_MAX_DISTANCE = 10;

const TILE_TYPE_2D = "2d";
const TILE_TYPE_3D = "3d";

const TILE_FORMAT_ZFP = "zfp";

const DEFAULT_WIDGET_WIDTH = 1024;
const DEFAULT_WIDGET_HEIGHT = 768;

const API_VERSION = 6;
const TILE_VERSION = 2;
const TILE_VERSION_3D = TILE_VERSION | 128;

const TILE_VERSION_MASK = 255; // mask to get base tile version (lower 8 bits)

const TILE_VERSION_FLAG_FLOAT32 = 256; // set 9th bit to indicate float32 tile data
const TILE_VERSION_FLAG_FLOAT64 = 512; // set 10th bit to indicate float64 tile data
const TILE_VERSION_FLAG_RGB_UINT8 = 1024; // set 11th bit to indicate uint8 RGB tile data


const PACKAGE_VERSION = "2.0.1";

export { TILE_VERSION_MASK, TILE_VERSION_FLAG_FLOAT32, QUANTILE_RELEVANT_DECIMALS, QUANTILE_STEP, INVALID_LOD_PLACEHOLDER, HALF_FLOAT_NAN_REPLACEMENT_VALUE, TILE_FORMAT_ZFP, HALF_FLOAT_NOT_LOADED_REPLACEMENT_VALUE, TILE_VERSION_FLAG_FLOAT64, TILE_VERSION_FLAG_RGB_UINT8, RaycastResultType, NAN_FACTOR_MASK_VALID_VALUE, NAN_FACTOR_MASK_NAN_VALUE, saveFloatArrayAsPNG,debounce, TileRequestIntention, roundToSparsityWithinRange, TILES_TEXTURE_NAME, QUANTILE_INDEX_AND_NAN_FACTOR_MASK_TEXTURE_NAME, WATER_RELATED_VARIABLE_KEYWORDS, NON_EXTREME_QUANTILE_INDEX, DEFAULT_FOV, DataType, RGB_NAN_ALPHA_VALUE, RGB_NOT_LOADED_ALPHA_VALUE, MAXIMUM_SUPPORTED_LOD, DeviceOrientation, PACKAGE_VERSION, roundDownToSparsity, roundUpToSparsity, roundToSparsity, positiveModulo, range, getIndexDimensionOfFace, getAddressedFacesOfDimension, getFacesOfIndexDimension, capitalizeString, DEFAULT_WIDGET_WIDTH, DEFAULT_WIDGET_HEIGHT, DEFAULT_COLORMAP, ANOMALY_PARAMETER_ID_SUFFIX, TILE_FORMAT_MAGIC_BYTES, TILE_VERSION, TILE_SIZE_2D, TILE_SIZE_3D, MAX_ZOOM_FACTOR, NAN_TILE_MAGIC_NUMBER, LOSSLESS_TILE_MAGIC_NUMBER, FLOAT_NAN_REPLACEMENT_VALUE, COLORMAP_STEPS, FLOAT_NOT_LOADED_REPLACEMENT_VALUE, API_VERSION, Dimension, CubeFace, TILE_TYPE_2D, TILE_TYPE_3D, ORTHOGRAPHIC_MIN_ZOOM, ORTHOGRAPHIC_MAX_ZOOM, PERSPECTIVE_MIN_DISTANCE, PERSPECTIVE_MAX_DISTANCE, TILE_VERSION_3D };
