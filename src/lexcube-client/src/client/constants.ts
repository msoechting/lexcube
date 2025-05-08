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

import { degToRad } from "three/src/math/MathUtils";

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
      if (data[i] == NAN_REPLACEMENT_VALUE) {
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

const TILE_SIZE = 256;
const MAX_ZOOM_FACTOR = 6.0;
const TILE_FORMAT_MAGIC_BYTES = "lexc";
const ANOMALY_PARAMETER_ID_SUFFIX= "_lxc_anomaly";
const NAN_TILE_MAGIC_NUMBER = -1;
const LOSSLESS_TILE_MAGIC_NUMBER = -2;
const NAN_REPLACEMENT_VALUE = -9999.0;
const NOT_LOADED_REPLACEMENT_VALUE = -99999.0;
const COLORMAP_STEPS = 1024;
const DEFAULT_COLORMAP = "viridis";

const DEFAULT_FOV: number = 40;

const DEFAULT_WIDGET_WIDTH = 1024;
const DEFAULT_WIDGET_HEIGHT = 768;

const API_VERSION = 5;
const TILE_VERSION = 2;

const PACKAGE_VERSION = "1.0.1";

export { saveFloatArrayAsPNG, DEFAULT_FOV, DeviceOrientation, PACKAGE_VERSION, roundDownToSparsity, roundUpToSparsity, roundToSparsity, positiveModulo, range, getIndexDimensionOfFace, getAddressedFacesOfDimension, getFacesOfIndexDimension, capitalizeString, DEFAULT_WIDGET_WIDTH, DEFAULT_WIDGET_HEIGHT, DEFAULT_COLORMAP, ANOMALY_PARAMETER_ID_SUFFIX, TILE_FORMAT_MAGIC_BYTES, TILE_VERSION, TILE_SIZE, MAX_ZOOM_FACTOR, NAN_TILE_MAGIC_NUMBER, LOSSLESS_TILE_MAGIC_NUMBER, NAN_REPLACEMENT_VALUE, COLORMAP_STEPS, NOT_LOADED_REPLACEMENT_VALUE, API_VERSION, Dimension, CubeFace }
