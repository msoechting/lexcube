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


function capitalizeString(s: string) {
    return s[0].toUpperCase() + s.slice(1);
}

const TILE_SIZE = 256;
const MAX_ZOOM_FACTOR = 6.0;
const TILE_FORMAT_MAGIC_BYTES = "lexc";
const ANOMALY_PARAMETER_ID_SUFFIX= "_lxc_anomaly";
const NAN_TILE_MAGIC_NUMBER = -1;
const LOSSLESS_TILE_MAGIC_NUMBER = -2;
const NAN_REPLACEMENT_VALUE = -9999.0; // hardcoded in shader, change there as well
const NOT_LOADED_REPLACEMENT_VALUE = -99999.0; // hardcoded in shader, change there as well
const COLORMAP_STEPS = 1024;
const DEFAULT_COLORMAP = "viridis";

const DEFAULT_WIDGET_WIDTH = 1024;
const DEFAULT_WIDGET_HEIGHT = 768;

const API_VERSION = 5;
const TILE_VERSION = 2;

const PACKAGE_VERSION = "0.4.19";

export { DeviceOrientation, PACKAGE_VERSION, positiveModulo, range, getIndexDimensionOfFace, getAddressedFacesOfDimension, getFacesOfIndexDimension, capitalizeString, DEFAULT_WIDGET_WIDTH, DEFAULT_WIDGET_HEIGHT, DEFAULT_COLORMAP, ANOMALY_PARAMETER_ID_SUFFIX, TILE_FORMAT_MAGIC_BYTES, TILE_VERSION, TILE_SIZE, MAX_ZOOM_FACTOR, NAN_TILE_MAGIC_NUMBER, LOSSLESS_TILE_MAGIC_NUMBER, NAN_REPLACEMENT_VALUE, COLORMAP_STEPS, NOT_LOADED_REPLACEMENT_VALUE, API_VERSION, Dimension, CubeFace }
