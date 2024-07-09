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

import { Euler, Event, Intersection, IUniform, Object3D, Vector2, Vector3 } from 'three'
import { clamp } from 'three/src/math/MathUtils';
import noUiSlider, { API, PartialFormatter } from 'nouislider';
import { CubeFace, Dimension, MAX_ZOOM_FACTOR, positiveModulo, range, TILE_SIZE, API_VERSION, capitalizeString, ANOMALY_PARAMETER_ID_SUFFIX, DEFAULT_COLORMAP } from './constants';
import { CubeClientContext } from './client';
import { Tile } from './tiledata';
import { OrbitControls } from './OrbitControls';
import 'polyfill-array-includes';
import QRCode from 'qrcode'



import parameterAttributionMetadata from '../content/parameterMetadataAttribution.json'
import parameterCustomColormapsMetadata from '../content/parameterCustomColormaps.json'
import defaultColormaps from '../content/default-colormaps.json'


class GeospatialContext {
    isValid() {
        return this.latMin !== undefined && this.latMax !== undefined && this.lonMin !== undefined && this.lonMax !== undefined;
    }

    guessFromGlobalCoverage(latitudeSteps: number) {
        const calculatedDegree = 180.0 / latitudeSteps;
        this.latMin = -90 + calculatedDegree * 0.5;
        this.latMax = 90 - calculatedDegree * 0.5;
        this.lonMin = -180 + calculatedDegree * 0.5;
        this.lonMax = 180 - calculatedDegree * 0.5;
        this.geospatialResolution = calculatedDegree;
    }

    setFromMetaInfo(meta: any) {
        this.latMin = meta.attrs.geospatial_lat_min ? Number(meta.attrs.geospatial_lat_min) : undefined;
        this.latMax = meta.attrs.geospatial_lat_max ? Number(meta.attrs.geospatial_lat_max) : undefined;
        this.lonMin = meta.attrs.geospatial_lon_min ? Number(meta.attrs.geospatial_lon_min) : undefined;
        this.lonMax = meta.attrs.geospatial_lon_max ? Number(meta.attrs.geospatial_lon_max) : undefined;
        this.geospatialResolution = meta.attrs.geospatial_resolution ? Number(meta.attrs.geospatial_resolution.match(/1\/(\d+)/)[1]) : undefined;
    }

    latMin: number | undefined;
    latMax: number | undefined;
    lonMin: number | undefined;
    lonMax: number | undefined;
    geospatialResolution: number | undefined;
}

class HoverData {
    constructor() {
        this.dataValue = 0;
        this.isDataValueNotLoaded = false;
        this.y = 0;
        this.x = 0;
        this.z = 0;
        this.face = 0;
        this.tileX = 0;
        this.tileY = 0;
        this.pixelX = 0;
        this.pixelY = 0;
        this.maximumCompressionError = 0;
    }

    face: CubeFace;
    dataValue: number;
    isDataValueNotLoaded: boolean;
    y: number;
    x: number;
    z: number;
    tileX: number;
    tileY: number;
    pixelX: number;
    pixelY: number;
    maximumCompressionError: number | undefined;
}


class SelectionState {
    cubeId: string | undefined;
    parameterId: string | undefined;
    zRange: number[] | undefined;
    yRange: number[] | undefined;
    xRange: number[] | undefined;
}

enum CubeDimensionType {
    Generic = 0,
    Time = 1,
    Latitude = 2,
    Longitude = 3,
}

function padDateElement(number: Number, amount: Number = 2) {
    return `00${number}`.slice(-amount);
}

function getDayString(date: Date) {
    return `${padDateElement(date.getUTCDate())}.${padDateElement(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`;
}

function getTimeString(date: Date, millisecondsDisplayed: boolean) {
    return `${padDateElement(date.getUTCHours())}:${padDateElement(date.getUTCMinutes())}:${padDateElement(date.getUTCSeconds())}${millisecondsDisplayed ? `:${padDateElement(date.getUTCMilliseconds(), 3)}` : ""}`;
}

class CubeDimension {
    private name: string = "Generic Dimension";
    steps: number;
    type: CubeDimensionType = CubeDimensionType.Generic;
    indices: Array<string> | Array<number> | Array<Date>;
    cubeDimensions: CubeDimensions;
    flipped: boolean = false;
    units: string = "";

    constructor(cubeDimensions: CubeDimensions, name: string, steps: number, indices: Array<any>, type: CubeDimensionType | null) {
        this.cubeDimensions = cubeDimensions;
        this.name = name;
        this.steps = Math.round(steps); // round for cases like 29.999999997
        this.type = type || this.guessType();
        if (this.type == CubeDimensionType.Time) {
            this.indices = indices.map((x) => new Date(x));
        } else {
            this.indices = indices;
        }
        if (this.steps !== this.indices.length) {
            console.warn("Dimension indices are mismatched to the dimension steps", this);
        }
    }

    private guessType(): CubeDimensionType {
        if (this.name == "time") {
            return CubeDimensionType.Time;
        } else if (["lat", "latitude"].includes(this.name.toLowerCase())) {
            return CubeDimensionType.Latitude;
        } else if (["lon", "longitude"].includes(this.name.toLowerCase())) {
            return CubeDimensionType.Longitude;
        }
        return CubeDimensionType.Generic;
    }

    getIndexString(numericIndex: number): string {
        const roundedIndex = clamp(Math.floor(numericIndex), 0, this.steps - 1);
        // if (roundedIndex != numericIndex) {
        //     console.warn("Non-integer index entered into getString of CubeDimensions", this);
        // }
        const indexLabel = this.indices[roundedIndex];
        if (this.type == CubeDimensionType.Time) {
            const totalTimeSpanDays = ((this.indices[this.indices.length - 1] as Date).getTime() - (this.indices[0] as Date).getTime()) / (1000 * 60 * 60 * 24);
            const secondsPerStep = ((this.indices[1] as Date).getTime() - (this.indices[0] as Date).getTime()) / (1000);
            const daysPerStep = secondsPerStep / (60 * 60 * 24);
            const millisecondsRelevant = secondsPerStep < 1;
            return `${totalTimeSpanDays > 1 ? getDayString(indexLabel as Date) : ""} ${daysPerStep < 1 ? getTimeString(indexLabel as Date, millisecondsRelevant) : ""}`.trim();
        } else if (this.type == CubeDimensionType.Latitude) {
            if (typeof(indexLabel) == "number") {            
                return this.cubeDimensions.getLatitudeStringFromIndexValue(indexLabel);
            } else if (this.cubeDimensions.geospatialContextProvided) {
                return this.cubeDimensions.getLatitudeStringFromStepAndGeospatialContext(roundedIndex, this.steps); 
            }
        } else if (this.type == CubeDimensionType.Longitude) {
            if (typeof(indexLabel) == "number") {
                return this.cubeDimensions.getLongitudeStringFromIndexValue(indexLabel);
            } else if (this.cubeDimensions.geospatialContextProvided) {
                return this.cubeDimensions.getLongitudeStringFromStepAndGeospatialContext(roundedIndex, this.steps);
            }
        } else if (typeof(indexLabel) == "number") {
            if (this.units) {
                return `${indexLabel} ${this.units}`;
            }
            return indexLabel.toLocaleString();
        }
        return `${indexLabel}`; 
    }

    getName() {
        if (this.type == CubeDimensionType.Time) {
            return "Time";
        } else if (this.type == CubeDimensionType.Latitude) {
            return "Latitude";
        } else if (this.type == CubeDimensionType.Longitude) {
            return "Longitude";
        }
        return capitalizeString(this.name);
    }

    getValueRange() {
        if (typeof(this.indices[0]) === "number") {
            return Math.abs((this.indices[0]) - (this.indices[this.indices.length - 1] as number));
        }
        return -1;
    }

    getMaxValue() {
        if (typeof(this.indices[0]) === "number") {
            return Math.max(...this.indices as Array<number>);
        }
        return -1;
    }
}

class CubeDimensions {
    // Maximum ranges of the whole cube
    x: CubeDimension;
    y: CubeDimension;
    z: CubeDimension;

    // Valid coverage ranges of the current parameter
    zParameterRange: ParameterRange = new ParameterRange();
    yParameterRange: ParameterRange = new ParameterRange();
    xParameterRange: ParameterRange = new ParameterRange();
    
    geospatialContextProvided: boolean = false;
    // in degrees
    geospatialLatitudeMax: number = -1;
    geospatialLatitudeMin: number = -1;
    geospatialLongitudeMax: number = -1;
    geospatialLongitudeMin: number = -1;

    context: CubeClientContext;

    constructor(context: CubeClientContext, dimensionNames: string[], dimensionSizes: any, indices: { "x": Array<any>, "y": Array<any>, "z": Array<any> }) {
        this.context = context;
        this.x = new CubeDimension(this, dimensionNames[2], dimensionSizes[dimensionNames[2]], indices["x"], null);
        this.y = new CubeDimension(this, dimensionNames[1], dimensionSizes[dimensionNames[1]], indices["y"], null);
        this.z = new CubeDimension(this, dimensionNames[0], dimensionSizes[dimensionNames[0]], indices["z"], null);
    }

    setGeospatialContext(geospatialLatitudeMin: number, geospatialLatitudeMax: number, geospatialLongitudeMin: number, geospatialLongitudeMax: number) {
        this.geospatialContextProvided = true;
        this.geospatialLatitudeMin = geospatialLatitudeMin;
        this.geospatialLatitudeMax = geospatialLatitudeMax;
        this.geospatialLongitudeMin = geospatialLongitudeMin;
        this.geospatialLongitudeMax = geospatialLongitudeMax;
    }

    totalWidthForFace(face: CubeFace) {
        if (face <= 3) {
            // front/back/top/bottom
            return this.x.steps;
        } else {
            // left/right
            return this.y.steps;
        }
    }

    totalHeightForFace(face: CubeFace) {
        if (face <= 1) {
            // front/back
            return this.y.steps;
        } else {
            // top/bottom/left/right
            return this.z.steps;
        }
    }

    xParameterRangeForFace(face: CubeFace) {
        if (face <= 3) {
            // front/back/top/bottom
            return this.xParameterRange;
        } else {
            // left/right
            return this.yParameterRange;
        }
    }

    yParameterRangeForFace(face: CubeFace) {
        if (face <= 1) {
            // front/back
            return this.yParameterRange;
        } else {
            // top/bottom/left/right
            return this.zParameterRange;
        }
    }

    xTilesForFace(face: CubeFace, lod: number) {
        return Math.ceil((this.totalWidthForFace(face) * Math.pow(0.5, lod)) / TILE_SIZE)
    }
    
    yTilesForFace(face: CubeFace, lod: number) {
        return Math.ceil((this.totalHeightForFace(face) * Math.pow(0.5, lod)) / TILE_SIZE)
    }

    totalTilesForFace(face: CubeFace, lod: number) {
        return this.xTilesForFace(face, lod) * this.yTilesForFace(face, lod);
    }

    private getLatitudeValueFromIndex(step: number, totalSteps: number) {
        const index = Math.round(step); // sometimes the value is like 29.99999999997, so round to prevent wrong result
        const lat = ((index / (totalSteps - 1)) * (this.geospatialLatitudeMax - this.geospatialLatitudeMin)) + this.geospatialLatitudeMin;
        return lat;
    }

    getLatitudeStringFromIndexValue(latitudeValue: number) {
        return `${this.decimalCoordinateToString(latitudeValue)}${latitudeValue >= 0 ? "N" : "S"}`;
    }

    getLatitudeStringFromStepAndGeospatialContext(step: number, totalSteps: number): string {
        const lat = this.getLatitudeValueFromIndex(step, totalSteps);
        return this.getLatitudeStringFromIndexValue(lat);
    }

    private getLongitudeValueFromIndex(step: number, totalSteps: number) {
        const index = Math.round(step);
        let lon = ((index / (totalSteps - 1)) * (this.geospatialLongitudeMax - this.geospatialLongitudeMin)) + this.geospatialLongitudeMin;
        if (this.context.interaction.cubeTags.includes(CubeTag.LongitudeZeroIndexIsGreenwich)) {
            lon = lon + 180;
            if (lon >= 180) {
                lon -= 360;
            }
        }
        return lon;
    }

    getLongitudeStringFromIndexValue(longitudeValue: number) {
        if (this.context.interaction.cubeTags.includes(CubeTag.LongitudeZeroIndexIsGreenwich) && longitudeValue >= 180) {
            longitudeValue = longitudeValue - 360;
        }
        return `${this.decimalCoordinateToString(longitudeValue)}${longitudeValue >= 0 ? "E" : "W"}`;
    }

    getLongitudeStringFromStepAndGeospatialContext(step: number, totalSteps: number): string {
        const lon = this.getLongitudeValueFromIndex(step, totalSteps);
        return this.getLongitudeStringFromIndexValue(lon);
    }

    private decimalCoordinateToString(coordinate: number) {
        const absolute = Math.abs(coordinate);
        const degrees = Math.floor(absolute);
        const minutes = (absolute - degrees) * 60;
        const wholeMinutes = Math.floor(minutes);
        const seconds = Math.floor((minutes - wholeMinutes) * 60);
        return `${degrees}°${wholeMinutes}'${seconds}"`;
    }

    roundParameterRangesToSparsity() {
        const int = this.context.interaction;
        this.yParameterRange.set(int.roundUpToSparsity(this.yParameterRange.min), int.roundDownToSparsity(this.yParameterRange.max));
        this.xParameterRange.set(int.roundUpToSparsity(this.xParameterRange.min), int.roundDownToSparsity(this.xParameterRange.max));
        this.zParameterRange.set(int.roundUpToSparsity(this.zParameterRange.min), int.roundDownToSparsity(this.zParameterRange.max));
    }

    getParameterRangeByDimension(dimension: Dimension) {
        if (dimension == Dimension.X) {
            return this.xParameterRange;
        } else if (dimension == Dimension.Y) {
            return this.yParameterRange;
        } else {
            return this.zParameterRange;
        }
    }
}

class ParameterColormapMetadata {
    key!: string;
    colormapMinimumValue?: number;
    colormapMaximumValue?: number;
    colormap?: string;
    colormapFlipped?: boolean;
}

class ParameterAttributionMetadata {
    project_name!: string;
    long_name!: string;
    dataset_link!: string;
    key!: string;
    domain!: string;
    short_name!: string;
    description!: string;
    long_name_pdf?: string;
    coverage?: string;
    references?: string;
    reference_link?: string;    
    reference_link2?: string;
}

class Parameter {
    constructor(name: string, sourceData: any, attributionData: ParameterAttributionMetadata | undefined, colormapData: ParameterColormapMetadata | undefined) {
        this.name = name;

        this.attributionMetadata = attributionData;
        this.coverageStartDate = new Date(sourceData.attrs.time_coverage_start);
        this.coverageEndDate = new Date(sourceData.attrs.time_coverage_end);
        this.longName = sourceData.attrs.long_name || attributionData?.long_name;
        this.comment = sourceData.attrs.comment;
        this.project = attributionData?.project_name || sourceData.attrs.project_name || "";
        this.units = sourceData.attrs.units || "";
        this.unitConversion = (a: number) => a;
        this.globalMinimumValue = sourceData.minimum_value;
        this.globalMaximumValue = sourceData.maximum_value;
        this.fixedColormapMinimumValue = (colormapData?.colormapMinimumValue !== undefined) ? colormapData.colormapMinimumValue : undefined;
        this.fixedColormapMaximumValue = (colormapData?.colormapMaximumValue !== undefined) ? colormapData.colormapMaximumValue : undefined;
        this.fixedColormap = colormapData?.colormap || undefined;
        // this.fixedColormapMinimumValue = -35;
        // this.fixedColormapMaximumValue = 35; 
        // this.fixedColormap = "balance";     
        this.fixedColormapFlipped = colormapData?.colormapFlipped || false;
        this.sourceData = sourceData;
        // this.parameterCoverageTime = new ParameterRange(selectedCubeDimensions.getTimeIndex(this.coverageStartDate), selectedCubeDimensions.getTimeIndex(this.coverageEndDate));
        this.parameterCoverageTime = new ParameterRange(sourceData["first_valid_time_slice"], sourceData["last_valid_time_slice"]);
        this.patchMetadata();
    }

    getConvertedDataValue(value: number) {
        return this.unitConversion(value);
    }

    private patchMetadata() {
        if (this.name == "precipitation_era5") {
            this.units = "mm day-1"
            this.unitConversion = (a: number) => a * 100;
        } else if (["k", "kelvin"].includes(this.units.toLowerCase()) && this.globalMaximumValue > 273.15) {
            this.units = "°C";
            this.unitConversion = (a: number) => a - 273.15;
        } else if (this.units == "mol m-2") {
            this.units = "mmol m-2";
            this.unitConversion = (a: number) => a * 1000;
        } else if (this.units == "J/m^2") {
            this.units = "MJ/m^2";
            this.unitConversion = (a: number) => a / 1000000;
        } else if (this.units == "g/m2") {
            this.units = "kg/m^2";
            this.unitConversion = (a: number) => a / 1000;
        } else if (this.units == "kg m**-2") {
            const target = -Math.round(Math.log10(this.globalMaximumValue) / 3);
            if (target >= 0) {
                this.units = `${["kg","g", "mg", "μg", "ng"][target]} m**-2`;
                this.unitConversion = (a: number) => a * Math.pow(10, 3*target);
            }
        }
    }

    getUnit() {
        if (["1", "-", "~"].includes(this.units)) {
            return "";
        } else {
            return ` ${this.units}`
        }
    }

    getUnitHTML() {
        return this.getUnit().replace(/(\w)(-?\d)/g, "$1<sup>$2</sup>").replace(/(\w)\^(-?\d)/g, "$1<sup>$2</sup>").replace(/(\w)\*\*(-?\d)/g, "$1<sup>$2</sup>")
    }
    
    isAnomalyParameter() {
        return this.name.endsWith(ANOMALY_PARAMETER_ID_SUFFIX);
    }

    sourceData: any;
    name: string;
    parameterCoverageTime: ParameterRange;
    coverageStartDate: Date;
    coverageEndDate: Date;
    longName: string;
    comment: string;
    project: string;
    globalMaximumValue: number;
    globalMinimumValue: number;
    attributionMetadata: ParameterAttributionMetadata | undefined;
    fixedColormapMinimumValue: number | undefined;
    fixedColormapMaximumValue: number | undefined;
    fixedColormap: string | undefined;
    fixedColormapFlipped: boolean;
    private units: string;
    private unitConversion: (a: number) => number;
}

class ParameterRange {
    min: number;
    max: number; // Upper bound is EXCLUSIVE

    constructor(min: number = 0, max: number = 0) {
        this.min = min;
        this.max = max;
    }

    public length() {
        return this.max - this.min;
    }

    public toString() {
        return `${this.min}-${this.max}`;
    }

    subRangeOf(outerRange: ParameterRange, overflowAllowed: boolean = false) {
        if (overflowAllowed) {
            return this.min >= outerRange.min && this.max <= outerRange.max * 2;
        }
        return this.min >= outerRange.min && this.max <= outerRange.max;
    }

    copy(other: ParameterRange) {
        this.min = other.min;
        this.max = other.max;
        return this;
    }

    set(min: number, max: number) {
        this.min = min;
        this.max = max;
        return this;
    }

    static copyFrom(other: ParameterRange): ParameterRange {
        return new ParameterRange().copy(other);
    }

    clone(): ParameterRange {
        return new ParameterRange().copy(this);
    }

    equals(other: ParameterRange) {
        return this.min == other.min && this.max == other.max;
    }
}

class CubeSelection {
    // Vector View
    private displaySizes: Vector2[];
    private displayOffsets: Vector2[];

    // Range View
    private xSelectionRange: ParameterRange;
    private ySelectionRange: ParameterRange;
    private zSelectionRange: ParameterRange;
    private context: CubeClientContext;

    constructor(context: CubeClientContext) {
        this.context = context;
        this.displaySizes = [];
        this.displayOffsets = [];
        const dims = this.context.interaction.cubeDimensions;
        const is = this.context.interaction.initialSelectionState;
        this.ySelectionRange = dims.yParameterRange.clone();
        if (!context.widgetMode) {
            this.xSelectionRange = new ParameterRange(0, context.interaction.roundDownToSparsity(dims.xParameterRange.max / context.interaction.XYdataAspectRatio));
        } else {
            this.xSelectionRange = dims.xParameterRange.clone();
        }
        if (context.interaction.cubeTags.includes(CubeTag.ESDC)) {
            const l = this.xSelectionRange.length();
            const offset = this.context.interaction.roundUpToSparsity(l * 0.83);
            this.xSelectionRange.set(offset, this.context.interaction.roundDownToSparsity(offset + l - 1))
        }
        if (context.interaction.cubeTags.includes(CubeTag.CamsEac4Reanalysis) || context.interaction.cubeTags.includes(CubeTag.Era5SpecificHumidity)) {
            const l = this.xSelectionRange.length();
            const offset = this.context.interaction.roundUpToSparsity(l * 1.8);
            this.xSelectionRange.set(offset, this.context.interaction.roundDownToSparsity(offset + l - 1))
        }
        this.zSelectionRange = dims.zParameterRange.clone();

        if (this.context.interaction.initialLoad) {
            this.parseInitialRange(is.xRange, dims.xParameterRange, this.xSelectionRange);
            this.parseInitialRange(is.yRange, dims.yParameterRange, this.ySelectionRange);
            this.parseInitialRange(is.zRange, dims.zParameterRange, this.zSelectionRange);
        }

        for (let face = 0; face < 3; face++) {
            this.displaySizes.push(new Vector2());
            this.displayOffsets.push(new Vector2());
            this.updateVectors(face*2);
        }
    }

    private parseInitialRange(parsedRange: number[] | undefined, parameterRange: ParameterRange, selectionRange: ParameterRange) {
        if (!parsedRange) {
            return;
        }
        const s = new ParameterRange(this.context.interaction.roundUpToSparsity(parsedRange[0]), this.context.interaction.roundDownToSparsity(parsedRange[1]));
        if (s.length() > 1 && s.subRangeOf(parameterRange)) {
            selectionRange.copy(s);
            this.context.log("Parsed initial selection range", s);
        }
    }

    parseSelectionBoundariesFromWidget(xMin: number, xMax: number, yMin: number, yMax: number, zMin: number, zMax: number) {
        const changed = [
            this.parseSelectionBoundary(xMin, xMax, Dimension.X),
            this.parseSelectionBoundary(yMin, yMax, Dimension.Y),
            this.parseSelectionBoundary(zMin, zMax, Dimension.Z)
        ].some((x) => x === true);
        if (changed) {
            this.updateAllVectors();
            this.context.rendering.updateVisibilityAndLodsDebounced();
            this.updateSelectionRelevantUi();
        }
    }

    parseSelectionBoundary(parsedLowerBoundary: number | undefined, parsedUpperBoundary: number | undefined, dimension: Dimension) {
        if (typeof(parsedLowerBoundary) != "number" || isNaN(parsedLowerBoundary) || parsedLowerBoundary < 0 || typeof(parsedUpperBoundary) != "number" || isNaN(parsedUpperBoundary) || parsedUpperBoundary < 0) {
            return false;
        }
        const selectionRange = this.getSelectionRangeByDimension(dimension);
        if (parsedLowerBoundary === undefined) {
            parsedLowerBoundary = selectionRange.min;
        }
        if (parsedUpperBoundary === undefined) {
            parsedUpperBoundary = selectionRange.max;
        }
        const attemptedRange = new ParameterRange(parsedLowerBoundary, parsedUpperBoundary);
        if (attemptedRange.equals(selectionRange)) {
            return false;
        }
        const parameterRange = this.context.interaction.cubeDimensions.getParameterRangeByDimension(dimension);
        if (attemptedRange.length() > 1 && attemptedRange.subRangeOf(parameterRange, this.context.rendering.overflow[dimension])) {
            selectionRange.copy(attemptedRange);
            return true;
        } else {
            throw new Error(`Invalid selection boundary ${attemptedRange} for dimension ${Dimension[dimension]} (Valid parameter range is ${parameterRange})`);
        }
    }

    private roundVectorToSparsity(vector: Vector2, minX: number, maxX: number, minY: number, maxY: number) {
        // if ((minX + maxX + minY + maxY) % 10 != 0) {
        //     console.warn(`Bad values in roundtoSparsity,vector ${vector},minX ${minX},maxX ${maxX},minY ${minY},maxY ${maxY}`)
        // }
        const int = this.context.interaction;
        const newVector = vector.clone();
        newVector.x = Math.max(int.roundUpToSparsity(minX), int.roundToSparsity(vector.x));
        if (newVector.x >= maxX) {
            newVector.x = int.roundDownToSparsity(maxX);
        }
        newVector.y = Math.max(int.roundUpToSparsity(minY), int.roundToSparsity(vector.y));
        if (newVector.y >= maxY) {
            newVector.y = int.roundDownToSparsity(maxY);
        }
        return newVector;
    }

    private roundSizeToSparsity(size: Vector2, face: CubeFace) {
        const maxX = this.context.interaction.cubeDimensions.totalWidthForFace(face);
        const maxY = this.context.interaction.cubeDimensions.totalHeightForFace(face);
        return this.roundVectorToSparsity(size, 0, maxX, 0, maxY);
    }

    private roundOffsetToSparsity(offset: Vector2, face: CubeFace) {
        const min = this.context.interaction.getMinimumDisplayOffset(face)
        const max = this.context.interaction.getMaximumDisplayOffset(face, this.displaySizes[Math.floor(face / 2)])
        if (face == CubeFace.Front || face == CubeFace.Back || face == CubeFace.Top || face == CubeFace.Bottom) {
            return this.roundVectorToSparsity(offset, -Infinity, Infinity, min.y, max.y);
        }
        return this.roundVectorToSparsity(offset, min.x, max.x, min.y, max.y);
    }

    setUniformLocations(face: number, size: IUniform<Vector2>, offset: IUniform<Vector2>) {
        size.value = this.displaySizes[Math.floor(face / 2)];
        offset.value = this.displayOffsets[Math.floor(face / 2)];
    }

    getSizeVector(face: CubeFace) {
        return this.displaySizes[Math.floor(face / 2)];
    }

    getOffsetVector(face: CubeFace) {
        return this.displayOffsets[Math.floor(face / 2)];
    }

    setVectorsNoRounding(face: CubeFace, size: Vector2, offset: Vector2) {
        this.displaySizes[Math.floor(face / 2)].copy(size.round());
        this.displayOffsets[Math.floor(face / 2)].copy(offset.round());
        this.updateAfterVectorChange(face, false);
    }

    setVectors(face: CubeFace, size: Vector2, offset: Vector2) {
        // console.log("setVectors")
        this.displaySizes[Math.floor(face / 2)].copy(this.roundSizeToSparsity(size, face));
        this.displayOffsets[Math.floor(face / 2)].copy(this.roundOffsetToSparsity(offset, face));
        this.updateAfterVectorChange(face, true);
    }

    setOffsetVectorNoRounding(face: CubeFace, newOffset: Vector2) {
        this.displayOffsets[Math.floor(face / 2)].copy(newOffset.round());
        this.updateAfterVectorChange(face, false);
    }

    setOffsetVector(face: CubeFace, newOffset: Vector2) {
        this.displayOffsets[Math.floor(face / 2)].copy(this.roundOffsetToSparsity(newOffset, face));
        this.updateAfterVectorChange(face, true);
    }
    
    private updateAfterVectorChange(face: CubeFace, finalChange: boolean) {
        this.updateRanges(face)
        this.updateOtherVectors(face);
        this.updateSelectionRelevantUi(finalChange);
        if (this.context.orchestrationMinionMode || this.context.orchestrationMasterMode) {
            this.context.networking.pushOrchestratorSelectionUpdate(this.displayOffsets, this.displaySizes, finalChange);
        }
    }

    applyVectorsFromOrchestrator(displayOffsets: Vector2[], displaySizes: Vector2[], finalChange: boolean) {
        for (let i = 0; i < 3; i++) {
            this.displayOffsets[i].copy(displayOffsets[i]);
            this.displaySizes[i].copy(displaySizes[i]);
        }

        for (let i = 0; i < 6; i++) {
            this.updateRanges(i);
        }
        if (finalChange) {
            this.context.rendering.updateVisibilityAndLods();
        }
        this.context.rendering.requestRender();
    }

    private updateSelectionRelevantUi(finalChange: boolean = true) {
        this.context.interaction.updateSlidersAndLabelsAfterChange();
        this.context.interaction.requestUrlFragmentUpdate();
        if (this.context.widgetMode && finalChange) {
            this.context.interaction.updateWidgetRanges();
        }
    }

    setRange(dimension: Dimension, min: number, max: number) {
        const range = this.getSelectionRangeByDimension(dimension);
        range.set(this.context.interaction.roundToSparsity(min), this.context.interaction.roundToSparsity(max));
        this.updateAllVectors();
        if (this.context.orchestrationMinionMode || this.context.orchestrationMasterMode) {
            this.context.networking.pushOrchestratorSelectionUpdate(this.displayOffsets, this.displaySizes, true);
        }
    }

    private updateVectors(face: CubeFace) {
        const xRange = this.xSelectionRangeForFace(face);
        const yRange = this.ySelectionRangeForFace(face);
        this.displaySizes[Math.floor(face / 2)].set(xRange.length(), yRange.length());
        this.displayOffsets[Math.floor(face / 2)].set(xRange.min, yRange.min);
        this.context.rendering.requestRender();
    }

    private updateRanges(face: CubeFace) {
        this.xSelectionRangeForFace(face).set(this.displayOffsets[Math.floor(face / 2)].x, this.displayOffsets[Math.floor(face / 2)].x + this.displaySizes[Math.floor(face / 2)].x);
        this.ySelectionRangeForFace(face).set(this.displayOffsets[Math.floor(face / 2)].y, this.displayOffsets[Math.floor(face / 2)].y + this.displaySizes[Math.floor(face / 2)].y);
    }

    private updateAllVectors() {
        for (let i = 0; i < 6; i++) {
            this.updateVectors(i)
        }
    }

    private updateOtherVectors(face: CubeFace) {
        for (let i = 0; i < 6; i++) {
            if (i != face) {
                this.updateVectors(i)
            }            
        }
    }

    private xSelectionRangeForFace(face: CubeFace) {
        if (face <= 1) {
            // front/back
            return this.xSelectionRange;
        } else if (face <= 3) {
            // top/bottom
            return this.xSelectionRange;
        } else {
            // left/right
            return this.ySelectionRange;
        }
    }

    private ySelectionRangeForFace(face: CubeFace) {
        if (face <= 1) {
            // front/back
            return this.ySelectionRange;
        } else if (face <= 3) {
            // top/bottom
            return this.zSelectionRange;
        } else {
            // left/right
            return this.zSelectionRange;
        }
    }

    getIndexValueForFace(face: CubeFace): number {
        if (face == CubeFace.Front) {
            return this.zSelectionRange.max;
        } else if (face == CubeFace.Back) {
            return this.zSelectionRange.min;
        } else if (face == CubeFace.Top) {
            return this.ySelectionRange.min;
        } else if (face == CubeFace.Bottom) {
            return this.ySelectionRange.max;
        } else if (face == CubeFace.Left) {
            return positiveModulo(this.xSelectionRange.min, this.context.interaction.cubeDimensions.x.steps);
        } else {
            return positiveModulo(this.xSelectionRange.max, this.context.interaction.cubeDimensions.x.steps);
        }
    }
    
    getSelectionRangeByDimension(dimension: Dimension): ParameterRange {
        if (dimension == Dimension.Z) {
            return this.zSelectionRange;
        } else if (dimension == Dimension.Y) {
            return this.ySelectionRange;
        } else {
            return this.xSelectionRange;
        }
    }
}

class LogicalDataCube {
    id!: string
    shortName!: string;
}

enum CubeTag {
    SpectralIndices,
    Global,
    Hainich,
    Auwald,
    ESDC,
    ESDC2,
    ESDC3,
    ECMWF,
    ColormappingFromObservedValues,
    LongitudeZeroIndexIsGreenwich,
    CamsEac4Reanalysis,
    OverflowX,
    Era5SpecificHumidity
}

class CubeInteraction {
    private context: CubeClientContext;
    updateUiDuringInteractions = {
        sliders: false,
        orbitControls: false,
    }; 

    private cameraPresets = [
        { name: "Diagonal Close-up South America", position: new Vector3(0.7334182744080036, -0.1937720441909164, 0.23593831568307924), rotation: new Euler(0.6875841168575725, 1.17633108419973, -0.6487348071441518, 'XYZ')},
        { name: "Full Earth - Front", position: new Vector3(2.080720175325273, 6.61750251743031e-17, 6.61750251743031e-17), rotation: new Euler(-6.162975822039155e-33, 1.5707963267948966, 0) },
        { name: "Look at right side", position: new Vector3(0.005694911428844007, 0.030379652376199662, -1.1831101491937133), rotation: new Euler(-3.115920506235054, 0.004811885820327965, 3.1414690954800735) },
        { name: "Tilted, front/left/top", position: new Vector3(1.799136954722411, 0.9117069475188829, 1.0651359111004994), rotation: new Euler(-0.7061832876241241, 0.9071865194182971, 0.5916191744172524) },
        { name: "Very far away", position: new Vector3(13.336517975968864, 2.399780986066818, 3.0129436502811733), rotation: new Euler(-0.6725973350194719, 1.2896276568959506, 0.653167025497404) },
        { name: "Multi-cube", position: new Vector3(5.72725123221618, 0, 0), rotation: new Euler(0.9273842476318528, 0.5*Math.PI, -0.9269676945976868) },
        { name: "Single Face (Front)", position: new Vector3(4.25, 0, 0), rotation: new Euler(0, Math.PI / 2, 0), zoom: 3.5 },
        { name: "Single Face (Back)", position: new Vector3(-4.25, 0, 0), rotation: new Euler(Math.PI, -Math.PI / 2, Math.PI), zoom: 3.5 },
        { name: "Single Face (Top)", position: new Vector3(1e-5, 4.25, 0), rotation: new Euler(-Math.PI / 2, 1e-8, Math.PI / 2), zoom: 3.5 },
        { name: "Single Face (Bottom)", position: new Vector3(1e-5, -4.25, 0), rotation: new Euler(Math.PI / 2, 0, -Math.PI / 2), zoom: 3.5 },
        { name: "Single Face (Left)", position: new Vector3(0, 0, 4.25), rotation: new Euler(0, 0, 0), zoom: 3.5 },
        { name: "Single Face (Right)", position: new Vector3(0, 0, -4.25), rotation: new Euler(Math.PI, 0, Math.PI), zoom: 3.5 },
    ];

    private htmlQualitySelect!: HTMLSelectElement;
    private htmlCubeSelect!: HTMLSelectElement;
    private htmlParameterSelect!: HTMLSelectElement;
    private htmlColormapFlippedCheckbox!: HTMLInputElement;
    private htmlColormapPercentileCheckbox!: HTMLInputElement;
    private htmlColormapButtonList!: HTMLDivElement;

    private htmlColormapMinInputDiv!: HTMLInputElement;
    private htmlColormapMaxInputDiv!: HTMLInputElement;

    private htmlColormapRangeApplyButton!: HTMLButtonElement;

    private statusMessageDiv!: HTMLElement;
    private hoverInfoDiv!: HTMLElement;
    private datasetInfoDialogDiv!: HTMLElement;
    private datasetInfoDialogWrapperDiv!: HTMLElement;
    private datasetInfoCornerListDiv!: HTMLElement;

    private zSliderDiv!: HTMLElement;
    private ySliderDiv!: HTMLElement;
    private xSliderDiv!: HTMLElement;

    private zSliderLabelDiv!: HTMLElement;
    private ySliderLabelDiv!: HTMLElement;
    private xSliderLabelDiv!: HTMLElement;

    private htmlColormapScaleGradient!: HTMLElement;
    private htmlColormapScaleTexts!: HTMLCollectionOf<Element>;
    private htmlColormapScaleUnitText!: HTMLElement;
    
    private htmlFullscreenButton!: HTMLElement;
    private htmlDataSelectButton!: HTMLElement;
    private htmlDownloadImageButton!: HTMLElement;
    private htmlDownloadPrintTemplateButton!: HTMLElement;
    
    private htmlPrintTemplateResultWrapper!: HTMLElement;
    private htmlPrintTemplateResult!: HTMLElement;
    private htmlPrintTemplateDownloadButtonPng!: HTMLAreaElement;
    private htmlPrintTemplateDownloadButtonSvg!: HTMLAreaElement;
    private htmlPrintTemplateDownloadEditNoteButton!: HTMLAreaElement;

    private htmlPrintTemplateLoadingSection!: HTMLElement;
    private htmlPrintTemplateLoaderVideo!: HTMLVideoElement;
    private htmlPrintTemplateResultSection!: HTMLElement;

    private htmlGpsButton!: HTMLElement 

    private htmlAnimateStartButton!: HTMLElement;
    private htmlAnimateStopButton!: HTMLElement;

    private htmlAxisLabelXMin!: HTMLElement;
    private htmlAxisLabelXMinParent!: HTMLElement;
    private htmlAxisLabelXMax!: HTMLElement;
    private htmlAxisLabelXMaxParent!: HTMLElement;
    private htmlAxisLabelXDimensionName!: HTMLElement;
    private htmlAxisLabelXDimensionNameParent!: HTMLElement;

    private htmlAxisLabelYMin!: HTMLElement;
    private htmlAxisLabelYMinParent!: HTMLElement;
    private htmlAxisLabelYMax!: HTMLElement;
    private htmlAxisLabelYMaxParent!: HTMLElement;
    private htmlAxisLabelYDimensionName!: HTMLElement;
    private htmlAxisLabelYDimensionNameParent!: HTMLElement;

    private htmlAxisLabelZMin!: HTMLElement;
    private htmlAxisLabelZMinParent!: HTMLElement;
    private htmlAxisLabelZMax!: HTMLElement;
    private htmlAxisLabelZMaxParent!: HTMLElement;
    private htmlAxisLabelZDimensionName!: HTMLElement;
    private htmlAxisLabelZDimensionNameParent!: HTMLElement;

    private htmlParent: HTMLElement;

    updateWidgetRanges: () => void = () => {};


    private getHtmlElementByClassName(className: string): HTMLElement {
        const elements = this.htmlParent.getElementsByClassName(className);
        if (elements.length != 1) {
            console.warn("Tried to access HTML element of class name", className, "but got", elements.length, "results.")
        }
        return elements[0] as HTMLElement;
    }

    private setupHtmlReferences() {
        this.htmlQualitySelect = this.getHtmlElementByClassName("quality-select")! as HTMLSelectElement;
        this.htmlCubeSelect = this.getHtmlElementByClassName("cube-select")! as HTMLSelectElement;
        this.htmlParameterSelect = this.getHtmlElementByClassName("parameter-select")! as HTMLSelectElement;
        this.htmlColormapFlippedCheckbox = this.getHtmlElementByClassName("colormap-flipped-checkbox")! as HTMLInputElement;
        this.htmlColormapPercentileCheckbox = this.getHtmlElementByClassName("colormap-percentile-checkbox")! as HTMLInputElement;
        this.htmlColormapButtonList = this.getHtmlElementByClassName("colormap-list")! as HTMLDivElement;
    
        this.zSliderDiv = this.getHtmlElementByClassName('z-selection-slider')!;
        this.ySliderDiv = this.getHtmlElementByClassName('y-selection-slider')!;
        this.xSliderDiv = this.getHtmlElementByClassName('x-selection-slider')!;
        
        this.zSliderLabelDiv = this.getHtmlElementByClassName('z-selection-slider-label')!;
        this.ySliderLabelDiv = this.getHtmlElementByClassName('y-selection-slider-label')!;
        this.xSliderLabelDiv = this.getHtmlElementByClassName('x-selection-slider-label')!;
    
        this.htmlColormapMinInputDiv = this.getHtmlElementByClassName("colormap-min-input") as HTMLInputElement;
        this.htmlColormapMaxInputDiv = this.getHtmlElementByClassName("colormap-max-input") as HTMLInputElement;
    
        this.htmlColormapRangeApplyButton = this.getHtmlElementByClassName("colormap-range-apply-button") as HTMLButtonElement;
        this.htmlColormapScaleGradient = this.getHtmlElementByClassName("color-scale-gradient")!;
        this.htmlColormapScaleTexts = this.htmlParent.getElementsByClassName("color-scale-label")!;
        this.htmlColormapScaleUnitText = this.getHtmlElementByClassName("color-scale-unit-label")!;
        this.htmlFullscreenButton = this.getHtmlElementByClassName('fullscreen-button')!;
        this.htmlDataSelectButton = this.getHtmlElementByClassName('data-select-button')!;
        this.htmlDownloadImageButton = this.getHtmlElementByClassName('download-image-button')!;
        this.htmlDownloadPrintTemplateButton = this.getHtmlElementByClassName('download-template-button')!;
        this.htmlPrintTemplateResultWrapper = this.getHtmlElementByClassName("print-template-result-wrapper")!;
        
        this.htmlPrintTemplateResult = this.getHtmlElementByClassName("print-template-result")!;
        this.htmlPrintTemplateDownloadButtonPng = this.getHtmlElementByClassName("download-print-template-result-png")! as HTMLAreaElement;
        this.htmlPrintTemplateDownloadButtonSvg = this.getHtmlElementByClassName("download-print-template-result-svg")! as HTMLAreaElement;
        this.htmlPrintTemplateDownloadEditNoteButton = this.getHtmlElementByClassName("download-print-template-result-edit-note")! as HTMLAreaElement;
        
        this.htmlPrintTemplateLoadingSection = this.getHtmlElementByClassName("print-template-loading-section")!;
        this.htmlPrintTemplateLoaderVideo = this.getHtmlElementByClassName("print-template-loader-video")! as HTMLVideoElement;
        this.htmlPrintTemplateResultSection = this.getHtmlElementByClassName("print-template-result-section")!;

        this.htmlGpsButton = this.getHtmlElementByClassName('gps-button')!;    
        
        this.htmlAnimateStartButton = this.getHtmlElementByClassName('animate-start-button')!;
        this.htmlAnimateStopButton = this.getHtmlElementByClassName('animate-stop-button')!;
            
        this.htmlAxisLabelXMin = this.getHtmlElementByClassName('axis-label-x-min')!;
        this.htmlAxisLabelXMinParent = this.getHtmlElementByClassName('axis-label-parent-x-min')!;
        this.htmlAxisLabelXMax = this.getHtmlElementByClassName('axis-label-x-max')!;
        this.htmlAxisLabelXMaxParent = this.getHtmlElementByClassName('axis-label-parent-x-max')!;
        this.htmlAxisLabelXDimensionName = this.getHtmlElementByClassName('axis-label-x-dimension-name')!;
        this.htmlAxisLabelXDimensionNameParent = this.getHtmlElementByClassName('axis-label-parent-x-dimension-name')!;
    
        this.htmlAxisLabelYMin = this.getHtmlElementByClassName('axis-label-y-min')!;
        this.htmlAxisLabelYMinParent = this.getHtmlElementByClassName('axis-label-parent-y-min')!;
        this.htmlAxisLabelYMax = this.getHtmlElementByClassName('axis-label-y-max')!;
        this.htmlAxisLabelYMaxParent = this.getHtmlElementByClassName('axis-label-parent-y-max')!;
        this.htmlAxisLabelYDimensionName = this.getHtmlElementByClassName('axis-label-y-dimension-name')!;
        this.htmlAxisLabelYDimensionNameParent = this.getHtmlElementByClassName('axis-label-parent-y-dimension-name')!;
    
        this.htmlAxisLabelZMin = this.getHtmlElementByClassName('axis-label-z-min')!;
        this.htmlAxisLabelZMinParent = this.getHtmlElementByClassName('axis-label-parent-z-min')!;
        this.htmlAxisLabelZMax = this.getHtmlElementByClassName('axis-label-z-max')!;
        this.htmlAxisLabelZMaxParent = this.getHtmlElementByClassName('axis-label-parent-z-max')!;
        this.htmlAxisLabelZDimensionName = this.getHtmlElementByClassName('axis-label-z-dimension-name')!;
        this.htmlAxisLabelZDimensionNameParent = this.getHtmlElementByClassName('axis-label-parent-z-dimension-name')!;

        this.statusMessageDiv = this.getHtmlElementByClassName("status-message")!;
        this.hoverInfoDiv = this.getHtmlElementByClassName("hover-info-ui")!;
        this.datasetInfoDialogDiv = this.getHtmlElementByClassName("dataset-info")!;
        this.datasetInfoDialogWrapperDiv = this.getHtmlElementByClassName("dataset-info-wrapper")!;
        this.datasetInfoCornerListDiv = this.getHtmlElementByClassName("dataset-info-corner-list")!;
    }

    fullyLoaded = false;

    private zSelectionSlider!: API;
    private ySelectionSlider!: API;
    private xSelectionSlider!: API;

    private availableCubes: LogicalDataCube[] = [];
    selectedCube!: LogicalDataCube;
    selectedParameterId!: string;
    
    cubeDimensions!: CubeDimensions;
    cubeSelection!: CubeSelection;
    private cubeParameters!: Map<string, Parameter>;
    private selectedParameter!: Parameter;
    selectedCubeMetadata!: { attrs: any, coords: any, data_vars: any, dims: any, max_lod: number, sparsity: number };

    private lastLonSliderIndex = 0; // for overflow / infinite longitude scroll

    private interactingFace = -1;
    private panStartUv = new Vector2();
    private panStartDisplayOffset = new Vector2();

    private hoverData: HoverData = new HoverData();

    private lastIndexValue: Array<number> = new Array<number>(6);
    private floatDisplaySignificance = 2;
    fullscreenActive: boolean = false;
 
    private colormapScaleCanvasContext!: CanvasRenderingContext2D;
    private colormapScaleWidth: number;
    private colormapScaleHeight: number = 25;
    private orbitControls!: OrbitControls;
    private currentZoomFactor: number[] = [1.0, 1.0, 1.0];
    private previousZoomFactor: number[] = [1.0, 1.0, 1.0];

    private currentZoomNewCenterPoint: Vector2 | undefined;
    private currentZoomOldCenterPoint: Vector2 | undefined;

    private currentTouchEventOnCube = true;
    private currentMouseEventOnCube = true;
    private currentMouseEventActive = false;

    private currentZoomFace: number = -1;

    private interactionFinishDisplaySize: Vector2 | undefined;
    private interactionFinishDisplayOffset: Vector2 | undefined;
    private interactionFinishFace: CubeFace | undefined;
    
    private deferredVisibilityAndLodUpdateMilliseconds = 150;
    private deferredVisibilityAndLodUpdateTimeoutHandler: number = 0;
    XYdataAspectRatio: number = 1; // longitude divided by latitude

    geospatialContextProvided: boolean = false;
    selectedColormapName!: string;
    selectedColormapCategory!: string;

    private animationVisibleTimeWindow = 50; // Visible time window
    private animationTotalSteps = 400; // Amount of animation steps, i.e. frames
    private animationCurrentStep = -1; // Current animation step, i.e. frame
    private animationTimeIncrementPerStep = -1; // Time increment per animation step, calculated from above values.
 
    private animationLastFrameTime = 0; 
    private animationLastStepTime = 0;
    private animationTargetFps = 10;

    private animationEnabled = false;

    private renderedAfterAllTilesDownloaded: boolean = false;
    
    cubeTags: CubeTag[] = [];

    initialLoad = true;
    private updateLabelPositionTimeoutId: number = 0;

    private additionalStatusMessageTimer: number = 0;
    private additionalStatusMessage: string = "";

    private localStorageUpdateWarningKey = "lexcube_jupyter_last_update_notification";
    private packageUpdateReminderInterval = 1000 * 60 * 60; // 1 hour

    constructor(context: CubeClientContext, htmlParent: HTMLElement) {
        this.context = context;
        this.colormapScaleWidth = context.widgetMode ? 180 : (context.isClientPortrait() ? 180 : 300);
        this.htmlParent = htmlParent;
        // if (window.innerWidth < window.innerHeight) {
        //     const c = document.getElementById("bottom-left-ui")!;
        //     c.id = "top-left-ui";
        //     c.insertBefore(c.children[1], c.children[0]);
        // }
        if (context.expertMode) {
            document.querySelector('style')!.innerHTML = ".expert-mode { display: block; }";
        }
    }

    async startup() {
        this.setupHtmlInterface();
        this.prepareUiSliders();
        this.initializeColormapScale();
        this.initializeColormapUi();
        this.selectColormapByName(DEFAULT_COLORMAP);
        this.registerEvents();
        this.applyCameraPreset();
        await this.retrieveMetaData();
        this.parseUrlFragment();
        await this.selectInitialCube();
    }
    
    private async selectInitialCube() {
        if (this.initialSelectionState.cubeId) {
            if (await this.findToSelectCube(this.initialSelectionState.cubeId)) {
                return;
            }
        }
        if (this.availableCubes.find(cube => cube.id == "esdc-3.0.2")) {
            if (await this.findToSelectCube("esdc-3.0.2")) {
                return;
            }
        }
        await this.findToSelectCube(this.availableCubes[0].id);    
    }

    private registerEvents() {
        const domElement = this.context.rendering.getDomElement();
        this.orbitControls = new OrbitControls(this.context, this.context.rendering.camera, domElement);

        if (this.updateUiDuringInteractions.orbitControls) {
            this.orbitControls.addEventListener("change", this.context.rendering.updateVisibilityAndLods.bind(this.context.rendering));
        } else {
            this.orbitControls.addEventListener("change", this.context.rendering.updateVisibilityAndLodsWithoutTriggeringDownloads.bind(this.context.rendering));
        }
        this.orbitControls.addEventListener("change", () => {
            this.updateLabelPositions();
            if (this.updateLabelPositionTimeoutId) {
                window.clearTimeout(this.updateLabelPositionTimeoutId);
            }
            this.updateLabelPositionTimeoutId = window.setTimeout( () => { this.updateLabelPositions(); this.updateLabelPositionTimeoutId = 0; }, 25);
        });
        this.orbitControls.addEventListener("end", this.context.rendering.updateVisibilityAndLods.bind(this.context.rendering));
        this.orbitControls.addEventListener("end", this.requestUrlFragmentUpdate.bind(this));
        
        const isOverBackground = (position: Vector2) => {
            return this.context.rendering.raycastWindowPosition(position.x, position.y).length == 0;
        }

        domElement.addEventListener( 'wheel', (ev: WheelEvent) => {
            if (!this.fullyLoaded) { 
                return; 
            }
            ev.preventDefault();
            ev.stopPropagation();
            // console.log("wheel");
            if (isOverBackground(this.getLocalEventPosition(ev))) {
                this.orbitControls.onMouseWheel(ev);
            } else {
                this.onZoom([ev], -ev.deltaY, true);
            }
            if (!this.currentMouseEventActive) { 
                // if panning and zooming at same time: do not refresh as selection may not be rounded to sparsity
                this.triggerDeferredVisibilityAndLodUpdate();
            } 
            
            this.context.rendering.requestRender();
        }, false);
        domElement.addEventListener( 'mousedown', (ev: any) => { 
            if (!this.fullyLoaded) { 
                return; 
            }
            this.currentMouseEventActive = true;
            const localEventPosition = this.getLocalEventPosition(ev);
            this.currentMouseEventOnCube = !isOverBackground(localEventPosition);
            // console.log("mousedown", "on cube:", this.currentMouseEventOnCube);
            (ev as any).actOnWorld = !this.currentMouseEventOnCube;
            if (!this.currentMouseEventOnCube) {
                this.orbitControls.onMouseDown(ev);
            } else {
                this.onPanStart(localEventPosition);
            }
            this.context.rendering.requestRender();
        }, false);
        domElement.addEventListener( 'mousemove', (ev: any) => {
            if (!this.fullyLoaded) { 
                return; 
            }            
            const localEventPosition = this.getLocalEventPosition(ev);
            const overCube = !isOverBackground(localEventPosition);
            domElement.style.cursor = overCube ? "all-scroll" : "default";
            if (!this.currentMouseEventActive) {
                if (overCube) {
                    this.updateHoverInfo(localEventPosition);
                    this.changeHoverInfoUiVisibility(true);
                } else {
                    this.changeHoverInfoUiVisibility(false);
                }
                return;
            }
            (ev as any).actOnWorld = !this.currentMouseEventOnCube;
            if (!this.currentMouseEventOnCube) {
                this.orbitControls.onMouseMove(ev);
            } else {
                this.onPanMove(localEventPosition);
            }
            this.context.rendering.requestRender();
        }, false);
        domElement.addEventListener( 'mouseup', (ev: any) => { 
            if (!this.fullyLoaded) { 
                return; 
            }
            this.currentMouseEventActive = false;
            (ev as any).actOnWorld = !this.currentMouseEventOnCube;
            if (!this.currentMouseEventOnCube) {
                this.orbitControls.onMouseUp(ev);
            } else {
                this.finishInteraction();
            }
            this.context.rendering.requestRender();
        }, false);

        domElement.addEventListener( 'touchstart', (ev: TouchEvent) => {
            if (!this.fullyLoaded) { 
                return; 
            }
            if (this.context.orchestrationMinionMode && ev.touches.length > 2) {
                (ev as any).touches = [ev.touches[0]];
            }
            this.currentTouchEventOnCube = !Array.from(ev.touches).some((value: Touch, index: number, array: Touch[]) => { return isOverBackground(this.getLocalEventPosition(value)) });
            (ev as any).actOnWorld = !this.currentTouchEventOnCube;
            this.orbitControls.onTouchStart(ev);
            this.context.rendering.requestRender();
        }, false);
        domElement.addEventListener( 'touchend', (ev: TouchEvent) => {
            if (!this.fullyLoaded) { 
                return; 
            }
            if (this.context.orchestrationMinionMode && ev.touches.length > 2) {
                (ev as any).touches = [ev.touches[0]];
            }
            (ev as any).actOnWorld = !this.currentTouchEventOnCube;
            this.finishInteraction();
            if (!this.currentTouchEventOnCube) {
                this.orbitControls.onTouchEnd(ev);
            }
            this.context.rendering.requestRender();
        }, false);
        domElement.addEventListener( 'touchmove', (ev: TouchEvent) => {
            if (!this.fullyLoaded) { 
                return; 
            }
            if (this.context.orchestrationMinionMode && ev.touches.length > 2) {
                (ev as any).touches = [ev.touches[0]];
            }
            (ev as any).actOnWorld = !this.currentTouchEventOnCube;
            this.orbitControls.onTouchMove(ev);
            this.context.rendering.requestRender();
        }, false);

        // window.addEventListener( 'keydown', this.orbitControls.onKeyDown, false );
    }

    updateLabelPositions() {
        if (!this.fullyLoaded) {
            return;
        }
        
        const labelPositions = this.context.rendering.getLabelPositions();
        const x = labelPositions[Dimension.X];
        const y = labelPositions[Dimension.Y];
        const z = labelPositions[Dimension.Z];
        const angleToTranslate = (v: number) => `translate(-${clamp(200*(0.75-Math.abs(1-v)), 0, 100)}%, -${clamp(200*(0.75-Math.abs(1-((v + 1.5) % 2))), 0, 100)}%)`;
        
        this.htmlAxisLabelXMinParent.style.color = x.visible ? "white" : "transparent";
        this.htmlAxisLabelXMaxParent.style.color = x.visible ? "white" : "transparent";
        this.htmlAxisLabelXDimensionNameParent.style.color = x.visible ? "grey" : "transparent";
        if (x.visible) {
            this.htmlAxisLabelXMinParent.style.top = `${x.screenPositionMinLabel.y}px`;
            this.htmlAxisLabelXMinParent.style.left = `${x.screenPositionMinLabel.x}px`;
            this.htmlAxisLabelXMaxParent.style.top = `${x.screenPositionMaxLabel.y}px`;
            this.htmlAxisLabelXMaxParent.style.left = `${x.screenPositionMaxLabel.x}px`;
            this.htmlAxisLabelXDimensionNameParent.style.top = `${x.screenPositionNameLabel.y}px`;
            this.htmlAxisLabelXDimensionNameParent.style.left = `${x.screenPositionNameLabel.x}px`;
            this.htmlAxisLabelXMin.style.transform = angleToTranslate(x.angleMinLabel);
            this.htmlAxisLabelXMax.style.transform = angleToTranslate(x.angleMaxLabel);
            this.htmlAxisLabelXDimensionName.style.transform = angleToTranslate(x.angleNameLabel);
        }
        this.htmlAxisLabelYMinParent.style.color = y.visible ? "white" : "transparent";
        this.htmlAxisLabelYMaxParent.style.color = y.visible ? "white" : "transparent";
        this.htmlAxisLabelYDimensionNameParent.style.color = y.visible ? "grey" : "transparent";
        if (y.visible) {
            this.htmlAxisLabelYMinParent.style.top = `${y.screenPositionMinLabel.y}px`;
            this.htmlAxisLabelYMinParent.style.left = `${y.screenPositionMinLabel.x}px`;
            this.htmlAxisLabelYMaxParent.style.top = `${y.screenPositionMaxLabel.y}px`;
            this.htmlAxisLabelYMaxParent.style.left = `${y.screenPositionMaxLabel.x}px`;
            this.htmlAxisLabelYDimensionNameParent.style.top = `${y.screenPositionNameLabel.y}px`;
            this.htmlAxisLabelYDimensionNameParent.style.left = `${y.screenPositionNameLabel.x}px`;
            this.htmlAxisLabelYMin.style.transform = angleToTranslate(y.angleMinLabel);
            this.htmlAxisLabelYMax.style.transform = angleToTranslate(y.angleMaxLabel);
            this.htmlAxisLabelYDimensionName.style.transform = angleToTranslate(y.angleNameLabel);
        }
        this.htmlAxisLabelZMinParent.style.color = z.visible ? "white" : "transparent";
        this.htmlAxisLabelZMaxParent.style.color = z.visible ? "white" : "transparent";
        this.htmlAxisLabelZDimensionNameParent.style.color = z.visible ? "grey" : "transparent";
        if (z.visible) {
            this.htmlAxisLabelZMinParent.style.top = `${z.screenPositionMinLabel.y}px`;
            this.htmlAxisLabelZMinParent.style.left = `${z.screenPositionMinLabel.x}px`;
            this.htmlAxisLabelZMaxParent.style.top = `${z.screenPositionMaxLabel.y}px`;
            this.htmlAxisLabelZMaxParent.style.left = `${z.screenPositionMaxLabel.x}px`;
            this.htmlAxisLabelZDimensionNameParent.style.top = `${z.screenPositionNameLabel.y}px`;
            this.htmlAxisLabelZDimensionNameParent.style.left = `${z.screenPositionNameLabel.x}px`;
            this.htmlAxisLabelZMin.style.transform = angleToTranslate(z.angleMinLabel);
            this.htmlAxisLabelZMax.style.transform = angleToTranslate(z.angleMaxLabel);
            this.htmlAxisLabelZDimensionName.style.transform = angleToTranslate(z.angleNameLabel);
        }
    }

    private triggerDeferredVisibilityAndLodUpdate() {
        if (this.deferredVisibilityAndLodUpdateTimeoutHandler) {
            window.clearTimeout(this.deferredVisibilityAndLodUpdateTimeoutHandler);
        }
        this.deferredVisibilityAndLodUpdateTimeoutHandler = window.setTimeout(() => this.context.rendering.updateVisibilityAndLods(), this.deferredVisibilityAndLodUpdateMilliseconds);
    }

    private finishInteraction() {
        if (this.interactionFinishDisplayOffset && this.interactionFinishDisplaySize) {
            this.cubeSelection.setVectors(this.interactionFinishFace!, this.interactionFinishDisplaySize, this.interactionFinishDisplayOffset);   
        } else if (this.interactionFinishDisplayOffset) {
            this.cubeSelection.setOffsetVector(this.interactionFinishFace!, this.interactionFinishDisplayOffset);
        }
        this.interactionFinishFace = undefined;
        this.interactionFinishDisplaySize = undefined;
        this.interactionFinishDisplayOffset = undefined;
        this.previousZoomFactor[Math.floor(this.currentZoomFace / 2)] = this.currentZoomFactor[Math.floor(this.currentZoomFace / 2)];
        this.currentZoomFace = -1;
        this.currentZoomNewCenterPoint = undefined;
        this.currentZoomOldCenterPoint = undefined;
        this.context.rendering.updateVisibilityAndLods();
    }

    onPanStart(initialPosition: Vector2) {
        const ray = this.context.rendering.raycastWindowPosition(initialPosition.x, initialPosition.y);
        const m = ray[0].face!.materialIndex;
        if (m < 0 || m >= 6) {
            return console.error("Bad material face index for interaction")
        }
        this.interactingFace = m;
        this.context.log("Panning:", CubeFace[this.interactingFace].toUpperCase())

        this.panStartUv.set(ray[0].uv!.x, ray[0].uv!.y);
        this.panStartDisplayOffset.copy(this.cubeSelection.getOffsetVector(this.interactingFace));
    }

    private normalizeOverflowingXValue(x: number, face: CubeFace) {
        const width = this.cubeDimensions.totalWidthForFace(face);
        const displaySize = this.cubeSelection.getSizeVector(face);
        const x1 = Math.floor(x / width);
        const x2 = Math.floor((x + displaySize.x) / width);
        if ((x1 > 0 && x2 > 0) || x1 < 0) {
            return positiveModulo(x, width);
        }
        return x;
    }

    getLocalEventPosition(event: Touch | MouseEvent) {
        return this.context.rendering.getLocalEventPosition(event);     
    }

    onPanMove(currentPosition: Vector2) {
        const ray = this.context.rendering.raycastWindowPosition(currentPosition.x, currentPosition.y);
        if (!ray || ray.length == 0) {
            // console.warn("Ray intersection is zero length");
            return;
        }
        const face = ray[0].face!.materialIndex;
        if (face != this.interactingFace) {
            return;
        }
        const displaySize = this.cubeSelection.getSizeVector(this.interactingFace);
        const uvDifference = new Vector2(ray[0].uv!.x - this.panStartUv.x, (ray[0].uv!.y - this.panStartUv.y));
        const newDisplayOffset = uvDifference.multiply(displaySize).sub(this.panStartDisplayOffset);
        newDisplayOffset.multiplyScalar(-1);
        if (this.context.rendering.overflow[Dimension.X] && (face == CubeFace.Front || face == CubeFace.Back || face == CubeFace.Top || face == CubeFace.Bottom)) {
            newDisplayOffset.y = clamp(newDisplayOffset.y, this.getMinimumDisplayOffset(face).y, this.getMaximumDisplayOffset(face, displaySize).y);
            newDisplayOffset.x = this.normalizeOverflowingXValue(newDisplayOffset.x, face);
        } else {
            newDisplayOffset.clamp(this.getMinimumDisplayOffset(face), this.getMaximumDisplayOffset(face, displaySize));
        }
        this.cubeSelection.setOffsetVectorNoRounding(this.interactingFace, newDisplayOffset);
        this.interactionFinishFace = face;
        this.interactionFinishDisplayOffset = newDisplayOffset;
    }

    onZoom(eventPositions: (MouseEvent | Touch)[], zoomDelta: number, immediate: boolean = false) {
        let ray: Intersection<Object3D<Event>>[];
        for (let i = 0; i < eventPositions.length; i++) {
            // position = eventPositions[i];             
            const localEventPosition = this.getLocalEventPosition(eventPositions[i]);
            ray = this.context.rendering.raycastWindowPosition(localEventPosition.x, localEventPosition.y);
            if (ray && ray[0]) {
                break;
            }
        }
        const r = ray!;
        if (!immediate && this.currentZoomFace == -1) {
            this.currentZoomFace = r[0]!.face!.materialIndex;
        }
        if (!r[0]) { 
            console.warn("No ray intersection during zoom event"); 
        }
        let uv = r[0].uv! || new Vector2(0.5, 0.5);
        if (eventPositions.length == 2) {
            const middle = this.getLocalEventPosition(eventPositions[0]).add(this.getLocalEventPosition(eventPositions[1])).multiplyScalar(0.5);
            const middleRay = this.context.rendering.raycastWindowPosition(middle.x, middle.y);
            if (middleRay && middleRay[0].face?.materialIndex == this.currentZoomFace) {
                uv = middleRay[0].uv!;
            }
        } else if (eventPositions.length == 1) {
            uv = r[0].uv!;
        } else {
            console.warn("No behavior for zooming with 3 or more positions")
        }
        if (Math.abs(zoomDelta) > 0.001) {
            this.changeZoomOnFace(Math.sign(zoomDelta) * clamp(Math.abs(zoomDelta), 0.001, 20.0) * 3, immediate ? r[0].face!.materialIndex : this.currentZoomFace, uv, immediate);
            return true;
        }
        return false;
    }

    private updateColormapOverrideRangesFromUi(updateColormap: boolean = true) {
        if (this.context.widgetMode) {
            return;
        }
        const td = this.context.tileData;
        if (this.htmlColormapMinInputDiv.value != "" && !isNaN(parseFloat(this.htmlColormapMinInputDiv.value))) {
            td.colormapMinValueOverride = parseFloat(this.htmlColormapMinInputDiv.value);
        } else {
            this.htmlColormapMinInputDiv.value = "";
            td.colormapMinValueOverride = undefined;
        }
        if (this.htmlColormapMaxInputDiv.value != "" && !isNaN(parseFloat(this.htmlColormapMaxInputDiv.value))) {
            td.colormapMaxValueOverride = parseFloat(this.htmlColormapMaxInputDiv.value);
        } else {
            this.htmlColormapMaxInputDiv.value = "";
            td.colormapMaxValueOverride = undefined;
        }
        if (updateColormap) {
            td.colormapHasChanged(true, false);
        }
    }

    private updateHoverInfo(mousePosition: Vector2) {
        const r = this.context.rendering.raycastWindowPosition(mousePosition.x, mousePosition.y);
        const face = r[0].face!.materialIndex;
        const uv = r[0].uv!;
        const offset = this.cubeSelection.getOffsetVector(face).clone();
        const size = this.cubeSelection.getSizeVector(face).clone();
        const hoverPosition = size.multiply(uv).add(offset);
        hoverPosition.x = positiveModulo(hoverPosition.x, this.cubeDimensions.totalWidthForFace(face))
        const lod = this.context.rendering.lods[face];
        const lodAdjustedTileSize = (Math.pow(2, lod) * TILE_SIZE);
        const tileX = Math.floor(hoverPosition.x / lodAdjustedTileSize);
        const tileY = Math.floor(hoverPosition.y / lodAdjustedTileSize);
        const uvWithinTileX = (hoverPosition.x % lodAdjustedTileSize) / lodAdjustedTileSize;
        const uvWithinTileY = (hoverPosition.y % lodAdjustedTileSize) / lodAdjustedTileSize;
        const pixelX = Math.floor(uvWithinTileX * TILE_SIZE);
        const pixelY = Math.floor(uvWithinTileY * TILE_SIZE);
        const dv = this.context.tileData.getDataValue(face, lod, tileX, tileY, pixelX, pixelY);
        this.hoverData.dataValue = dv.value;
        this.hoverData.isDataValueNotLoaded = dv.isDataNotLoaded;
        this.hoverData.face = face;
        this.hoverData.tileX = tileX;
        this.hoverData.tileY = tileY;
        this.hoverData.pixelX = pixelX;
        this.hoverData.pixelY = pixelY;
        this.hoverData.x = (face <= 3) ? hoverPosition.x : this.cubeSelection.getIndexValueForFace(face);
        this.hoverData.y = (face > 3) ? hoverPosition.x : ((face <= 1) ? hoverPosition.y : this.cubeSelection.getIndexValueForFace(face));
        this.hoverData.z = (face > 1) ? hoverPosition.y : this.cubeSelection.getIndexValueForFace(face);
        this.hoverData.maximumCompressionError = this.context.tileData.maxCompressionErrors.get(new Tile(face, (face <= 1 ? this.hoverData.z : (face <= 3 ? this.hoverData.y : this.hoverData.x)), lod, tileX, tileY, this.selectedCube.id, this.selectedParameterId).getHashKey());
        this.updateHoverInfoUi();
    }

    private updateHoverInfoUi() {
        let lines = [];

        if (this.hoverData.isDataValueNotLoaded) {
            lines.push(`Value: Data not yet loaded`)
        } else if (isNaN(this.hoverData.dataValue)) {
            lines.push(`Value: No Data`);
        } else {
            const value = `${this.toFixed(this.selectedParameter.getConvertedDataValue(this.hoverData.dataValue))}`;
            lines.push(`Value: ${value} ${this.selectedParameter.getUnitHTML()}`);
        }
        lines.push(`${this.cubeDimensions.z.getName()}: ${this.cubeDimensions.z.getIndexString(this.hoverData.z)}${this.context.debugMode ? ` (Z / ${this.hoverData.z})` : ""}`);
        lines.push(`${this.cubeDimensions.y.getName()}: ${this.cubeDimensions.y.getIndexString(this.hoverData.y)}${this.context.debugMode ? ` (Y / ${this.hoverData.y})` : ""}`);
        lines.push(`${this.cubeDimensions.x.getName()}: ${this.cubeDimensions.x.getIndexString(this.hoverData.x)}${this.context.debugMode ? ` (X / ${this.hoverData.x})` : ""}`);
        if (this.context.debugMode) {
            lines.push(`Max. error introduced by compression in this tile: ${this.hoverData.maximumCompressionError}`)
            lines.push(`Face: ${CubeFace[this.hoverData.face]} (${this.hoverData.face})`)
            lines.push(`Tile x: ${this.hoverData.tileX} y: ${this.hoverData.tileY}, Pixel x: ${this.hoverData.pixelX} y: ${this.hoverData.pixelY}`)
            lines.push(`Display Quality: ${(100*Math.pow(0.5, this.context.rendering.lods[this.hoverData.face])).toFixed(2)}% (LoD ${this.context.rendering.lods[this.hoverData.face]})`)
        }

        let html = "";
        for (const line of lines) {
            const color = line.indexOf("failed") > -1 ? "#ff4444" : "white";
            html +=`<div style='color: ${color}'>${line}</div>`
        }
        this.hoverInfoDiv.innerHTML = html;
    }

    private changeHoverInfoUiVisibility(visible: boolean) {
        if (visible) {
            this.hoverInfoDiv.style.display = "inline-block";
        } else {
            this.hoverInfoDiv.style.display = "none";
        }
    }

    updateColormapRangeUi() {
        const td = this.context.tileData;
        this.htmlColormapMinInputDiv.placeholder = (td.colormapUseStandardDeviation) ? `${this.toFixed(td.statisticalColormapLowerBound)} (${td.statisticalColormapLowerBound == td.observedMinValue ? "same" : this.toFixed(td.observedMinValue)})` : this.toFixed(td.observedMinValue);
        this.htmlColormapMaxInputDiv.placeholder = (td.colormapUseStandardDeviation) ? `${this.toFixed(td.statisticalColormapUpperBound)} (${td.statisticalColormapUpperBound == td.observedMaxValue ? "same" : this.toFixed(td.observedMaxValue)})` : this.toFixed(td.observedMaxValue);
    }

    private toFixed(float: number): string {
        return `${Number(float.toFixed(this.floatDisplaySignificance))}`;
    }

    showVersionOutofDateWarning(new_version: string, old_version: string) {
        try {
            const s = localStorage.getItem(this.localStorageUpdateWarningKey);
            if (s) {
                const lastReminder = new Date(s);
                const now = new Date();
                if (now.getTime() - lastReminder.getTime() < this.packageUpdateReminderInterval) {
                    return;
                }
            }
        } catch (e) {
            console.log("Could not access local storage");
        }
        localStorage.setItem(this.localStorageUpdateWarningKey, new Date().toISOString());
        this.additionalStatusMessage = `New version ${new_version} available! (current: ${old_version})<br>Upgrade using "pip install lexcube --upgrade".`;
        this.additionalStatusMessageTimer = window.setTimeout(() => {
            this.additionalStatusMessageTimer = 0;
            this.additionalStatusMessage = "";
            this.updateStatusMessage();
        }, 10000);
        this.updateStatusMessage();
    }

    private lastStatusMessageProgress: number[] = [0, 0, 0, 0];

    updateStatusMessage(tileDownloadsTriggered?: number, tileDownloadsFinished?: number, tileDownloadsFailed?: number, tileDecodesFailed?: number) {
        if (tileDownloadsTriggered !== undefined && tileDownloadsFinished !== undefined && tileDownloadsFailed !== undefined && tileDecodesFailed !== undefined) {
            this.lastStatusMessageProgress = [tileDownloadsTriggered, tileDownloadsFinished, tileDownloadsFailed, tileDecodesFailed];
        }
        const downloadsTriggered = this.lastStatusMessageProgress[0];
        const downloadsFinished = this.lastStatusMessageProgress[1];
        const downloadsFailed = this.lastStatusMessageProgress[2];
        const decodeFailed = this.lastStatusMessageProgress[3];

        let lines = [];

        if ((downloadsFinished + downloadsFailed) != downloadsTriggered) {
            const n = downloadsTriggered - (downloadsFinished + downloadsFailed);
            if (this.context.expertMode) {
                lines.push(`${n} tile${n == 1 ? "" : "s"} downloading...`);
            } else if (this.context.widgetMode) {
                const percentage = Math.round(downloadsTriggered / downloadsFinished * 100);
                lines.push(`Accessing data (${percentage}%)...`);
            } else {
                lines.push("Downloading...");
            }
        }

        if (downloadsFailed > 0) {
            lines.push(this.context.expertMode ? `${tileDownloadsFailed} tile downloads failed` : "Some downloads failed - try refreshing?");
        }
        if (decodeFailed > 0) {
            lines.push(this.context.expertMode ? `${tileDecodesFailed} tile decodes failed` : "Something went wrong - try refreshing?");
        }
        
        if (this.additionalStatusMessage) {
            lines.push(this.additionalStatusMessage);
        }

        if (lines.length > 0) {
            this.statusMessageDiv.style.display = "inline-block";
            let html = "";
            for (const line of lines) {
                const color = line.indexOf("version") > -1 ? "#48eeff" : ((line.indexOf("failed") > -1 || line.indexOf("went wrong") > -1) ? "#ff4444" : "white");
                html +=`<div style='color: ${color}'>${line}</div>`
            }
            this.statusMessageDiv.innerHTML = html;
        } else {
            if (!this.additionalStatusMessage) {
                this.statusMessageDiv.style.display = "none";
            }
        }
    }

    private setupHtmlInterface() {
        if (this.context.noUiMode) {
            document.body.childNodes.forEach(n => {
                if (n.nodeName == "DIV") {
                    (n as any).style.display = "none";
                }
            });
        }
        this.setupHtmlReferences();
        
        this.htmlQualitySelect.onchange = (() => {
            this.context.rendering.displayQuality = parseFloat(this.htmlQualitySelect.selectedOptions[0].value);
            this.context.rendering.updateVisibilityAndLods();
        })

        this.htmlCubeSelect.onchange = () => { 
            this.selectCube(this.availableCubes[this.htmlCubeSelect.options.selectedIndex]);
            this.requestUrlFragmentUpdate();
        }

        this.htmlParameterSelect.onchange = () => {
            this.selectParameter(this.htmlParameterSelect.value);
            this.requestUrlFragmentUpdate();
        }

        this.htmlColormapFlippedCheckbox.onchange = () => {
            this.context.tileData.colormapFlipped = this.htmlColormapFlippedCheckbox.checked;
            this.context.tileData.colormapHasChanged(true, false);
        }

        this.htmlColormapPercentileCheckbox.onchange = () => {
            this.context.tileData.colormapUseStandardDeviation = this.htmlColormapPercentileCheckbox.checked;
            this.updateColormapRangeUi();
            this.context.tileData.colormapHasChanged(true, false);
        }

        this.htmlColormapRangeApplyButton.onclick = () => {
            this.updateColormapOverrideRangesFromUi();
        };

        const triggerFullscreen = () => {
            let elem = this.htmlParent as any;
            if (!this.fullscreenActive) {
                if (elem.requestFullscreen) {
                    elem.requestFullscreen();
                } else if (elem.webkitRequestFullscreen) { /* Safari */
                    elem.webkitRequestFullscreen();
                } else if (elem.msRequestFullscreen) { /* IE11 */
                    elem.msRequestFullscreen();
                }
                this.fullscreenActive = true;
                this.context.rendering.onWindowResize();
            } else {
                let doc = document as any;
                if (doc.exitFullscreen) {
                    doc.exitFullscreen();
                } else if (doc.webkitExitFullscreen) { /* Safari */
                    doc.webkitExitFullscreen();
                } else if (doc.msExitFullscreen) { /* IE11 */
                    doc.msExitFullscreen();
                }
                this.fullscreenActive = false;
                this.context.rendering.onWindowResize();
            }            
        };
        this.htmlFullscreenButton.onclick = triggerFullscreen;

        this.htmlParent.addEventListener("fullscreenchange", (event) => {
            this.fullscreenActive = (document.fullscreenElement !== null);
            this.context.rendering.onWindowResize();
        });

        window.onkeydown = ((ev: KeyboardEvent) => {
            if (this.context.orchestrationMinionMode && ev.key == "5") { 
                triggerFullscreen();
            }
        })

        // this.htmlDataSelectButton.onclick = () => {
        //     // this.selectParameter(this.selectedParameterId);       
        //     this.applyCameraPreset();
        //     this.context.rendering.updateVisibilityAndLods();
        // }
        this.htmlAnimateStartButton.onclick = () => {
            this.startAnimation();
        }
        this.htmlAnimateStopButton.onclick = () => {
            this.stopAnimation();
        }
        
        if (this.context.studioMode && !this.context.widgetMode) {
            this.htmlDownloadImageButton.onclick = () => {
                this.context.rendering.downloadScreenshotFromUi(false);
            }
            this.htmlDownloadImageButton.style.display = "block";
        }
        if (!this.context.widgetMode) {
            this.htmlDownloadPrintTemplateButton.onclick = () => {
                this.context.rendering.startDownloadPrintTemplate();
            }
    
            this.htmlGpsButton.onclick = () => {
                if (!this.gpsTrackingEnabled) {
                    this.startGps();
                } else {
                    this.stopGps();
                }
            }
        }

        this.datasetInfoDialogWrapperDiv.onclick = () => this.datasetInfoDialogWrapperDiv.style.display = "none";
        this.getHtmlElementByClassName("dataset-info-window")!.onclick = (ev) => { ev.stopPropagation(); };
    }

    private startAnimation() {
        this.animationEnabled = true;
        this.animationCurrentStep = -1;
        this.animationTimeIncrementPerStep = -1;
        this.htmlAnimateStartButton.style.display = "none";
        this.htmlAnimateStopButton.style.display = "block";
        this.attemptNextAnimationStep();
    }
    
    private stopAnimation() {
        this.animationEnabled = false;
        this.htmlAnimateStartButton.style.display = "block";
        this.htmlAnimateStopButton.style.display = "none";
    }

    /**
     * From: https://refreshless.com/nouislider/examples/
     * @param slider HtmlElement with an initialized slider
     * @param threshold Minimum proximity (in percentages) to merge tooltips
     * @param separator String joining tooltips
     */
    private mergeSliderTooltips(slider: HTMLElement & { noUiSlider: any }, threshold: number, separator: string) {

        var textIsRtl = getComputedStyle(slider).direction === 'rtl';
        var isRtl = slider.noUiSlider.options.direction === 'rtl';
        var isVertical = slider.noUiSlider.options.orientation === 'vertical';
        var tooltips = slider.noUiSlider.getTooltips();
        var origins = slider.noUiSlider.getOrigins();

        // Move tooltips into the origin element. The default stylesheet handles this.
        tooltips.forEach(function (tooltip: any, index: number) {
            if (tooltip) {
                origins[index].appendChild(tooltip);
            }
        });

        slider.noUiSlider.on('update', function (values: any, handle: any, unencoded: any, tap: any, positions: any) {

            var pools: number[][] = [[]];
            var poolPositions: number[][] = [[]];
            var poolValues: string[][] = [[]];
            var atPool = 0;

            // Assign the first tooltip to the first pool, if the tooltip is configured
            if (tooltips[0]) {
                pools[0][0] = 0;
                poolPositions[0][0] = positions[0];
                poolValues[0][0] = values[0];
            }

            for (var i = 1; i < positions.length; i++) {
                if (!tooltips[i] || (positions[i] - positions[i - 1]) > threshold) {
                    atPool++;
                    pools[atPool] = [];
                    poolValues[atPool] = [];
                    poolPositions[atPool] = [];
                }

                if (tooltips[i]) {
                    pools[atPool].push(i);
                    poolValues[atPool].push(values[i]);
                    poolPositions[atPool].push(positions[i]);
                }
            }

            pools.forEach(function (pool, poolIndex) {
                var handlesInPool = pool.length;

                for (var j = 0; j < handlesInPool; j++) {
                    var handleNumber = pool[j];

                    if (j === handlesInPool - 1) {
                        var offset = 0;

                        poolPositions[poolIndex].forEach(function (value) {
                            offset += 1000 - value;
                        });

                        var isRight = poolPositions[poolIndex].every(p => p > 50);

                        var last = isRtl ? 0 : handlesInPool - 1;
                        var lastOffset = 1000 - poolPositions[poolIndex][last];
                        offset = (textIsRtl && !isVertical ? 100 : 0) + (offset / handlesInPool) - lastOffset;
                        if (handlesInPool > 1) {
                            if (poolPositions[poolIndex].every(p => p > 75)) {
                                offset = clamp(offset, 15, 85);
                            }
                        }

                        // Center this tooltip over the affected handles
                        const formatter = (slider.noUiSlider as any).formatter;
                        if (formatter) {
                            tooltips[handleNumber].innerHTML = poolValues[poolIndex].map((str: string) => formatter.to(parseInt(str))).join(separator);
                        } else {
                            tooltips[handleNumber].innerHTML = poolValues[poolIndex].join(separator);
                        }
                        tooltips[handleNumber].style.display = 'block';
                        if (handlesInPool > 1) {
                            tooltips[handleNumber].style['right'] = isRight ? offset + '%' : 'auto';
                            tooltips[handleNumber].style['left']  = !isRight ? (30-offset) + '%' : 'auto';
                        } else {
                            tooltips[handleNumber].style['right'] = offset + '%';
                            tooltips[handleNumber].style['left']  = 'auto';
                        }
                    } else {
                        // Hide this tooltip
                        tooltips[handleNumber].style.display = 'none';
                    }
                }
            });
        });
    }

    private gpsPositionReceived(position: { coords: { latitude: number, longitude: number }}) {
        const crd = position.coords;
        const relativeLatitude = (-crd.latitude - this.cubeDimensions.geospatialLatitudeMin) / (this.cubeDimensions.geospatialLatitudeMax - this.cubeDimensions.geospatialLatitudeMin);
        const relativeLongitude = (crd.longitude - this.cubeDimensions.geospatialLongitudeMin) / (this.cubeDimensions.geospatialLongitudeMax - this.cubeDimensions.geospatialLongitudeMin);
        const threshold = 0.2;
        if (relativeLatitude < -threshold || relativeLongitude < -threshold || relativeLatitude > 1+threshold || relativeLongitude > 1+threshold) {
            window.alert("Your current location is not within the bounds of the cube. GPS will be deactivated.");
            this.stopGps();
            return;
        }
        this.context.rendering.updateGpsPosition(relativeLatitude, relativeLongitude);
    }

    private gpsPositionError(error: any) {
        this.context.log(`Gps position error: (${error.code}): ${error.message}`);
    }

    private gpsTrackingEnabled = false;
    private gpsTrackingId: number = 0;

    private startGps() {
        if (!this.geospatialContextProvided) {
            return window.alert("Currently selected cube does not have geospatial context, cannot enable GPS position tracking.")
        }
        this.gpsTrackingEnabled = true;
        this.htmlGpsButton.style.filter = "drop-shadow(0px 0px 6px #fff)";
        this.gpsTrackingId = navigator.geolocation.watchPosition(this.gpsPositionReceived.bind(this), this.gpsPositionError.bind(this), {
            enableHighAccuracy: true,
            timeout: 5000,
            maximumAge: 0
        });
    }

    private stopGps() {
        this.htmlGpsButton.style.filter = "";
        this.gpsTrackingEnabled = false;
        this.context.rendering.disableGpsPosition();
        navigator.geolocation.clearWatch(this.gpsTrackingId)
    }

    private prepareSlider(div: HTMLElement, parameterUpdate: (arr: string[]) => void, viewUpdate: () => void, formatter?: PartialFormatter) {
        let slider = noUiSlider.create(div, {
            start: [20, 30],
            connect: true,
            step: 1,
            tooltips: formatter || true,
            behaviour: 'drag',
            range: {
                'min': 0,
                'max': 100
            }
        });
        (slider as any).formatter = formatter;

        if (this.updateUiDuringInteractions.sliders) {
            slider.on("slide", viewUpdate as any);
        }
        slider.on("slide", parameterUpdate as any);
        slider.on("set", viewUpdate as any);
        slider.on("set", parameterUpdate as any);
        // slider.on("set", triggerTileDownloads);
        // slider.on("end", triggerTileDownloads);
        return slider;
    }

    private prepareUiSliders() {
        if (this.context.widgetMode) {
            return;
        }
        const zUpdate = (newRange: string[]) => {
            this.cubeSelection.setRange(Dimension.Z, parseInt(newRange[0]), parseInt(newRange[1]));
            this.updateLabelsAfterChange();
        }
        const yUpdate = (newRange: string[]) => {
            this.cubeSelection.setRange(Dimension.Y, parseInt(newRange[0]), parseInt(newRange[1]));
            this.updateLabelsAfterChange();
        }
        const xUpdate = (newRange: string[]) => {
            this.cubeSelection.setRange(Dimension.X, parseInt(newRange[0]), parseInt(newRange[1]));
            this.updateLabelsAfterChange();
        }
        const viewUpdate = () => {
            this.context.rendering.updateVisibilityAndLods();
            this.requestUrlFragmentUpdate();
        }

        const zFormatter = {
            to: (value: number) => {
                const dims = this.context.interaction.cubeDimensions;
                if (typeof dims === "undefined") {
                    return ''
                }
                return dims.z.getIndexString(value);
            },
        }
        const yFormatter = {
            to: (value: number) => {
                const dims = this.context.interaction.cubeDimensions;
                if (typeof dims === "undefined") {
                    return ''
                }
                return dims.y.getIndexString(value);
            },
        }
        const xFormatter = {
            to: (value: number) => {
                const dims = this.context.interaction.cubeDimensions;
                if (typeof dims === "undefined") {
                    return ''
                }
                if (this.context.interaction.cubeTags.includes(CubeTag.LongitudeZeroIndexIsGreenwich) && (value >= dims.xParameterRange.length() || value < 0)) {
                    value = positiveModulo(value, dims.xParameterRange.length());
                }
                return dims.x.getIndexString(value);
            },
        }
        this.zSelectionSlider = this.prepareSlider(this.zSliderDiv, zUpdate, viewUpdate, zFormatter);
        this.ySelectionSlider = this.prepareSlider(this.ySliderDiv, yUpdate, viewUpdate, yFormatter);
        this.xSelectionSlider = this.prepareSlider(this.xSliderDiv, xUpdate, viewUpdate, xFormatter);

        const allSliders = this.htmlParent.getElementsByClassName("noUi-connect");
        for (let s of allSliders) {
            (s as any).style.background = "#36082a";
        }
    }

    private updateSliderLabels() {
        if (this.context.widgetMode) {
            return;
        }
        this.zSliderLabelDiv.innerHTML = `${this.cubeDimensions.z.getName()}:`;
        this.ySliderLabelDiv.innerHTML = `${this.cubeDimensions.y.getName()}:`;
        this.xSliderLabelDiv.innerHTML = `${this.cubeDimensions.x.getName()}:`;
    }

    private updateSelectionUiRangeBounds() {
        if (this.context.widgetMode) {
            return;
        }
        const zRange = this.cubeDimensions.zParameterRange;
        const yRange = this.cubeDimensions.yParameterRange;
        const xRange = this.cubeDimensions.xParameterRange;
        const sliderOffset = this.cubeTags.includes(CubeTag.LongitudeZeroIndexIsGreenwich) ? (Math.round(xRange.length() / 2)) : 0;
        this.zSelectionSlider.updateOptions({range: { min: zRange.min, max: zRange.max }, step: this.selectedCubeMetadata.sparsity, margin: this.selectedCubeMetadata.sparsity }, false);
        this.ySelectionSlider.updateOptions({range: { min: yRange.min, max: yRange.max }, step: this.selectedCubeMetadata.sparsity, margin: this.selectedCubeMetadata.sparsity }, false);
        this.xSelectionSlider.updateOptions({range: { min: this.roundUpToSparsity(xRange.min + sliderOffset), max: this.roundDownToSparsity(xRange.max + sliderOffset - 1) }, step: this.selectedCubeMetadata.sparsity, margin: this.selectedCubeMetadata.sparsity }, false);
        this.zSelectionSlider.off("update");
        this.ySelectionSlider.off("update");
        this.xSelectionSlider.off("update");
        this.mergeSliderTooltips(this.zSliderDiv as any, 40, " - ");
        if (this.geospatialContextProvided) {
            this.mergeSliderTooltips(this.ySliderDiv as any, 40, " - ");
            this.mergeSliderTooltips(this.xSliderDiv as any, 40, " - ");
        }
    }

    updateSlidersAndLabelsAfterChange(updateSliders: boolean = true, updateLabels: boolean = true) {
        if (updateSliders) {
            this.updateSliderValuesAfterChange();
        }
        if (updateLabels) {
            this.updateLabelsAfterChange();
        }
    }

    updateSliderValuesAfterChange() {
        const zSelectionRange = this.cubeSelection.getSelectionRangeByDimension(Dimension.Z);
        const ySelectionRange = this.cubeSelection.getSelectionRangeByDimension(Dimension.Y);
        const xSelectionRange = this.cubeSelection.getSelectionRangeByDimension(Dimension.X);
        this.updateLabelsAfterChange();

        if (this.context.widgetMode) {
            return;
        }

        const lonRange = this.cubeDimensions.xParameterRange;
        const sliderOffset = this.cubeTags.includes(CubeTag.LongitudeZeroIndexIsGreenwich) ? this.roundUpToSparsity(lonRange.length() / 2) : 0;
        const overflowBias = xSelectionRange.length() / lonRange.length() * 0.5; // magic value for good compromise between overflowing longitude slider value early and late
        const lonIndex = Math.floor((xSelectionRange.min - sliderOffset) / this.cubeDimensions.x.steps + overflowBias); 
        if (lonIndex != this.lastLonSliderIndex) {
            const newMinimum = this.roundDownToSparsity(lonIndex * this.cubeDimensions.x.steps + sliderOffset);
            const newMaximum = this.roundDownToSparsity(lonIndex * this.cubeDimensions.x.steps + lonRange.max + sliderOffset);
            this.xSelectionSlider.updateOptions({ range: { min: newMinimum, max: newMaximum }}, false);
            this.lastLonSliderIndex = lonIndex;
            
            this.xSelectionSlider.off("update");
            if (this.geospatialContextProvided) {
                this.mergeSliderTooltips(this.xSliderDiv as any, 40, " - ");
            }
        }
        this.xSelectionSlider.set([xSelectionRange.min, xSelectionRange.max], false);
        this.ySelectionSlider.set([ySelectionRange.min, ySelectionRange.max], false);
        this.zSelectionSlider.set([zSelectionRange.min, zSelectionRange.max], false);
    }

    updateLabelsAfterChange() {
        const zSelectionRange = this.cubeSelection.getSelectionRangeByDimension(Dimension.Z);
        const ySelectionRange = this.cubeSelection.getSelectionRangeByDimension(Dimension.Y);
        const xSelectionRange = this.cubeSelection.getSelectionRangeByDimension(Dimension.X);
        const dims = this.cubeDimensions;
        this.htmlAxisLabelXMin.textContent = `${this.cubeDimensions.x.getIndexString(positiveModulo(xSelectionRange.min, dims.x.steps))}`;
        this.htmlAxisLabelXMax.textContent = `${this.cubeDimensions.x.getIndexString(positiveModulo(xSelectionRange.max, dims.x.steps))}`;
        this.htmlAxisLabelYMin.textContent = `${this.cubeDimensions.y.getIndexString(ySelectionRange.min)}`;
        this.htmlAxisLabelYMax.textContent = `${this.cubeDimensions.y.getIndexString(ySelectionRange.max)}`;
        this.htmlAxisLabelZMin.textContent = `${this.cubeDimensions.z.getIndexString(zSelectionRange.min)}`;
        this.htmlAxisLabelZMax.textContent = `${this.cubeDimensions.z.getIndexString(zSelectionRange.max)}`;
        this.htmlAxisLabelXDimensionName.textContent = `${this.cubeDimensions.x.getName()}`;
        this.htmlAxisLabelYDimensionName.textContent = `${this.cubeDimensions.y.getName()}`;
        this.htmlAxisLabelZDimensionName.textContent = `${this.cubeDimensions.z.getName()}`;
    }

    private getAttributionParameterMetadata(parameter: string) {
        let id = this.selectedCube.shortName.indexOf("Hainich") > -1 ? "Hainich" : this.selectedCube.id;
        if (Object.keys(parameterAttributionMetadata).indexOf(id) == -1) {
            return undefined;
        } 
        const additionalMetadata: [] = (parameterAttributionMetadata as any)[id];
        const p = additionalMetadata.find(a => a["key"] == parameter);
        if (!p) {
            return undefined;
        }        
        return p as ParameterAttributionMetadata;
    }

    private getColormapParameterMetadata(parameter: string) {
        let id = this.selectedCube.shortName.indexOf("Hainich") > -1 ? "Hainich" : this.selectedCube.id;
        if (Object.keys(parameterCustomColormapsMetadata).indexOf(id) == -1) {
            return undefined;
        } 
        const additionalMetadata: [] = (parameterCustomColormapsMetadata as any)[id];
        const p = additionalMetadata.find(a => a["key"] == parameter);
        if (!p) {
            return undefined;
        }        
        return p as ParameterColormapMetadata;
    }

    private updateDatasetInfoAndShow(updateParameterInfo: boolean = true, showPopup: boolean = false) {
        const makeLink = (link: string, linkText?: string) => `<a target="_blank" rel="noopener" href='${link}'>${linkText || link}</a>`;
        let dialogLines: string[] = [];
        let cornerLines: string[] = [];
        const dialogParameterHeading = (value: string) => (dialogLines.push(`<div><b>${value}</b></div>`));
        const dialogParameterValue = (value: string) => (dialogLines.push(`<div style="margin-left:5%;margin-bottom:8px">${value}</b></div>`));
        const cornerLineBold = (value: string) => { if (value && value.length > 0) (cornerLines.push(`<div><b>${value}</b></div>`)) };
        const cornerLineUnderline = (value: string) => { if (value && value.length > 0) (cornerLines.push(`<div style="text-decoration:underline;"><a>${value}</a></div>`)) };
        const cornerLine = (value: string) => { if (value && value.length > 0) (cornerLines.push(`<div>${value}</div>`)) };
        const cornerLineSmall = (value: string) => { if (value && value.length > 0) (cornerLines.push(`<div style='font-size: 70%;'>${value}</div>`)) };

        let parameterLines = new Map<string, string>();
        const p = this.selectedParameter.attributionMetadata;
        if (p && p.long_name) {
            // cornerLine(entry["description"])
            // if (p["project_name"]) cornerLine(`Data Source: ${p["project_name"]}`);
            if (this.cubeTags.includes(CubeTag.SpectralIndices)) {
                parameterLines.set("Index Abbreviation:", `${p["key"]}`);
                parameterLines.set("Full Index Name:", `${p["long_name"]}`);
                cornerLineBold(p["key"]);
                cornerLine(p["long_name"]);
                if (this.selectedCube.shortName.indexOf("Sentinel-2") > -1) {
                    cornerLine(`Source Project: Sentinel-2 L2A, ESA`);
                } else if (this.selectedCube.shortName.indexOf("MODIS") > -1) {
                    cornerLine(`Source Project: MODIS, Terra-Aqua, USGS`);
                } else if (this.selectedCube.shortName.indexOf("Planet Fusion") > -1) {
                    cornerLine(`Source Project: Planet-Fusion, Planet`);
                }
            } else {   
                cornerLineBold(p["long_name"]);
                parameterLines.set("Parameter:", p["long_name"]);
                if (p["project_name"]) cornerLine(`Data Source: ${p["project_name"]}`);
            }
            cornerLineUnderline(`Data attribution and license`);
            if (p["project_name"]) parameterLines.set("Source Project:", `${p["project_name"]} (<a target="_blank" rel="noopener" href='${p["dataset_link"]}'>${p["dataset_link"]}</a>)`);
            parameterLines.set("Description:", p["description"]);
            if (p["references"]) {
                let r = `${p["references"]}`;
                if (p["reference_link"]) {
                    const doipos = r.indexOf("doi:");
                    if (doipos > -1) {
                        r = r.substring(0, doipos);
                    }
                    r += ` <a target="_blank" rel="noopener" href='${p["reference_link"]}'>${p["reference_link"]}</a>`
                }
                if (p["reference_link2"]) {
                    const doipos = r.indexOf("doi:");
                    if (doipos > -1) {
                        r = r.substring(0, doipos);
                    }
                    r += `, <a target="_blank" rel="noopener" href='${p["reference_link2"]}'>${p["reference_link2"]}</a>`
                }
                parameterLines.set("Reference:", r);
            } else if (p["reference_link"]) {
                parameterLines.set("Reference:", makeLink(p["reference_link"]));
            }
        } else if (this.cubeTags.includes(CubeTag.ESDC3)) {
            const attrs = this.selectedParameter.sourceData.attrs;
            cornerLineBold(attrs["long_name"]);
            parameterLines.set("Parameter:", attrs["long_name"]);
            if (this.selectedParameter.project) cornerLine(`Data Source: ${this.selectedParameter.project}`);
        
            cornerLineUnderline(`Data attribution and license`);
            if (attrs["acknowledgment"]) parameterLines.set("Acknowledgment:", `${attrs["acknowledgment"]} (<a target="_blank" rel="noopener" href='${attrs["source"]}'>${attrs["source"]}</a>)`);
            parameterLines.set("Description:", attrs["description"]);
            parameterLines.set("Reference:", `<a target="_blank" rel="noopener" href='${attrs["references"]}'>${attrs["references"]}</a>`);
        }
        else if (this.selectedParameter && Object.keys(this.selectedParameter.sourceData.attrs).length > 0 && updateParameterInfo) {
            const p = this.selectedParameter.sourceData["attrs"];
            this.context.log("Selected parameter sourcedata", p);
            cornerLineBold(`${p["long_name"] || this.selectedParameterId}`);
            if (this.cubeTags.includes(CubeTag.CamsEac4Reanalysis)) {
                cornerLine(`Data Source: CAMS global reanalysis (EAC4), ECMWF`);
                parameterLines.set("Parameter:", p["long_name"]);
                parameterLines.set("Dataset:", "CAMS global reanalysis (EAC4) monthly averaged, ECMWF (" + makeLink("https://ads.atmosphere.copernicus.eu/cdsapp#!/dataset/cams-global-reanalysis-eac4-monthly") + ")")
                parameterLines.set("Dataset Reference:", "Inness, A, Ades, M, Agustí-Panareda, A, Barré, J, Benedictow, A, Blechschmidt, A, Dominguez, J, Engelen, R, Eskes, H, Flemming, J, Huijnen, V, Jones, L, Kipling, Z, Massart, S, Parrington, M, Peuch, V-H, Razinger M, Remy, S, Schulz, M and Suttie, M (2019): CAMS global reanalysis (EAC4) monthly averaged fields. Copernicus Atmosphere Monitoring Service (CAMS) Atmosphere Data Store (ADS).")
            } else if (this.cubeTags.includes(CubeTag.Era5SpecificHumidity)) {
                cornerLine(`Data Source: ERA5, ECMWF`);
                parameterLines.set("Parameter:", p["long_name"]);
                parameterLines.set("Dataset:", "ERA5 monthly averaged data on pressure levels from 1940 to present, ECMWF (" + makeLink("https://cds.climate.copernicus.eu/cdsapp#!/dataset/reanalysis-era5-pressure-levels-monthly-means?tab=overview") + ")");
                parameterLines.set("Dataset Reference:", "Hersbach, H., Bell, B., Berrisford, P., Biavati, G., Horányi, A., Muñoz Sabater, J., Nicolas, J., Peubey, C., Radu, R., Rozum, I., Schepers, D., Simmons, A., Soci, C., Dee, D., Thépaut, J-N. (2023): ERA5 monthly averaged data on pressure levels from 1940 to present. Copernicus Climate Change Service (C3S) Climate Data Store (CDS), DOI: 10.24381/cds.6860a573")

            }
        } else if (this.context.widgetMode && this.selectedParameterId == "default_var") {
            // cornerLineBold(`${this.selectedParameterId}`);
        } else {
            cornerLineBold(`${this.selectedParameterId}`);
        }
        if (!this.context.widgetMode) {
            cornerLineSmall(`<div>When using Lexcube and/or generated images acknowledge/cite: M. Söchting et al., doi: <a href="https://doi.org/10.1109/MCG.2023.3321989" target="blank" onclick="return true">10.1109/MCG.2023.3321989</a>.</div>`);
        }

        let dialogHtml = "";
        let cornerHtml = "";
        dialogParameterHeading("<h2>Attribution & License</h2>")

        if (parameterLines.size > 0) {
            // html += `<div><b>Dataset info for parameter ${selectedParameterName}</b></div>`
            for (let key of parameterLines.keys()) {
                if (parameterLines.get(key) && parameterLines.get(key)!.length > 0) {
                    dialogParameterHeading(key);
                    dialogParameterValue(parameterLines.get(key)!);
                }
            }
        }
        dialogLines.push("<hr>")
        if (this.cubeTags.includes(CubeTag.ESDC2)) {
            dialogParameterHeading("Data Integration")
            dialogParameterValue("All data was postprocessed and merged in the Earth System Data Cube v2.1.1 as part of the ESA (Deep) Earth System Data Lab project.");
        } else if (this.cubeTags.includes(CubeTag.ESDC3)) {
            dialogParameterHeading("Data Integration")
            dialogParameterValue("All data was postprocessed and merged in the Earth System Data Cube v3.0.2 as part of the ESA (Deep) Earth System Data Lab project.");
        } else if (this.cubeTags.includes(CubeTag.SpectralIndices)) {
            dialogParameterHeading("Data Source")
            if (this.selectedCube.shortName.indexOf("Sentinel-2") > -1) {
                dialogParameterValue("MSI, Sentinel-2 L2A, Copernicus, ESA. <a target='_blank' rel='noopener noreferrer' href='https://sentinels.copernicus.eu/web/sentinel/missions/sentinel-2'>https://sentinels.copernicus.eu/web/sentinel/missions/sentinel-2</a>");
            } else if (this.selectedCube.shortName.indexOf("MODIS") > -1) {
                dialogParameterValue("MODIS, Terra-Aqua, LP DAAC, USGS. <a target='_blank' rel='noopener noreferrer' href='https://lpdaac.usgs.gov/data/get-started-data/collection-overview/missions/modis-overview/'>https://lpdaac.usgs.gov/data/get-started-data/collection-overview/missions/modis-overview/</a>");
            } else if (this.selectedCube.shortName.indexOf("Planet Fusion") > -1) {
                dialogParameterValue("Planet-Fusion, Planet. <a target='_blank' rel='noopener noreferrer' href='https://www.planet.com/products/monitoring/'>https://www.planet.com/products/monitoring/</a>");
            }
            dialogParameterHeading("Data Integration")
            dialogParameterValue("Spectral indices data calculated and aggregated by <a target='_blank' href='https://rsc4earth.de/authors/dmontero/'>David Montero</a> using his open-source <a target='_blank' href='https://github.com/awesome-spectral-indices/awesome-spectral-indices'>awesome-spectral-indices</a> libraries.");
        }
        dialogParameterHeading("Data Cube Concept")
        dialogParameterValue("In this visualization, data cubes are displayed as space-time cubes with the time axis extending into the background. For more information on the data cube concept, see <a target='_blank' href='https://esd.copernicus.org/articles/11/201/2020/'>Earth System Data Cubes Unravel Global Multivariate Dynamics by Mahecha et al. (2020)</a>.")
        dialogParameterHeading("Data Visualization")
        dialogParameterValue("A PhD project by Maximilian Söchting; advisors Gerik Scheuermann & Miguel Mahecha, Leipzig University. A cooperation of the Image and Signal Processing Group (Inst. of Computer Science) and Earth System Data Sciences group (Remote Sensing Centre for Earth System Research).")
        dialogParameterHeading("Funding")
        dialogParameterValue("This project is supported by the National Research Data Infrastructure for Earth System Sciences NFDI4Earth (pilot projects), the German Science Foundation (DFG) and the European Space Agency (ESA) via the DeepExtremes and DeepESDL projects.")
        // dialogParameterValue("<hr>");
        // dialogParameterHeading("Attribution")
        // dialogParameterValue(`<b>When using Lexcube-generated images acknowledge/cite</b>: M. Söchting, M. D. Mahecha, D. Montero and G. Scheuermann, "Lexcube: Interactive Visualization of Large Earth System Data Cubes," in IEEE Computer Graphics and Applications, doi: https://www.doi.org/10.1109/MCG.2023.3321989.`)
        
        for (let line of dialogLines) {
            dialogHtml +=`${line}`
        }
        for (let line of cornerLines) {
            cornerHtml += `${line}`
        }
        if (!this.context.widgetMode) {
            this.datasetInfoCornerListDiv.innerHTML = cornerHtml;
        }
        for (let e of this.datasetInfoCornerListDiv.children) {
            (e as HTMLElement).style.cursor = "pointer";
            (e as HTMLElement).style.pointerEvents = "auto";
            if (!this.context.widgetMode) {
                (e as HTMLElement).style.width = "fit-content";
            }
            (e as HTMLElement).onclick = () => this.updateDatasetInfoAndShow(true, true);
        }

        this.datasetInfoDialogDiv.innerHTML = dialogHtml;
        if (showPopup) {
            this.datasetInfoDialogWrapperDiv.style.display = 'flex';
        }
    }

    private parameterBeingSelected = false;

    selectParameter(parameterId: string, cubeChanged: boolean = false) {
        if (this.parameterBeingSelected || !this.cubeParameters.has(parameterId)) {
            this.context.log("Did not select parameter", parameterId);
            return false;
        }
        this.context.log("Select parameter", parameterId);
        this.parameterBeingSelected = true;
        this.fullyLoaded = false;
        if (this.animationEnabled) {
            this.stopAnimation();
        }
        if (this.context.orchestrationMasterMode && !cubeChanged) {
            this.context.networking.pushOrchestratorParameterUpdate(parameterId);
        }
        if (this.cubeTags.includes(CubeTag.ColormappingFromObservedValues)) { // if using observed values for color mapping
            this.context.rendering.hideData();
        }
        this.htmlParameterSelect.value = parameterId;
        this.selectedParameterId = parameterId;
        this.selectedParameter = this.cubeParameters.get(parameterId)!;
        if (this.context.scriptedMultiViewMode) {
            const defaultColumns = Math.ceil(Math.sqrt(this.htmlParameterSelect.options.length));
            const defaultRows = Math.ceil(this.htmlParameterSelect.options.length / defaultColumns);
            const parameterIndex = Math.floor((this.htmlParameterSelect.selectedIndex - 1) / 3); //Array.from(this.cubeParameters.keys()).indexOf(parameterId);
            const colmatch = document.URL.match(/columns=(\d+)/);
            const columns = (colmatch && colmatch.length > 0) ? parseInt(colmatch[1]) : defaultColumns;
            const rowmatch = document.URL.match(/rows=(\d+)/);
            const rows = (rowmatch && rowmatch.length > 0) ? parseInt(rowmatch[1]) : defaultRows;
            const pos = new Vector2(0.5 + parameterIndex % columns, 0.5 + Math.floor(parameterIndex / columns));
            const spacing = 0.2;
            const cubeSize = 1;
            const rowSize = columns * cubeSize + (columns - 1) * spacing;
            const columnSize = rows * cubeSize + (rows - 1) * spacing;
            const position = new Vector3(0, -(-columnSize / 2 + pos.y * (cubeSize + spacing)), -(-rowSize / 2 + pos.x * (cubeSize + spacing)));
            this.context.rendering.cube.position.copy(position);
        }

        this.context.tileData.resetDataStatistics();
        
        if (this.cubeDimensions.z.type == CubeDimensionType.Time && this.selectedParameter.parameterCoverageTime.length() > 1) {
            this.cubeDimensions.zParameterRange.copy(this.selectedParameter.parameterCoverageTime);
        } else {
            this.cubeDimensions.zParameterRange.set(0, this.cubeDimensions.z.steps - 1);
        }
        this.lastLonSliderIndex = NaN;
        this.cubeDimensions.roundParameterRangesToSparsity();

        this.currentZoomFactor = [1.0, 1.0, 1.0];
        this.previousZoomFactor = [1.0, 1.0, 1.0];

        this.context.log(this.cubeDimensions);

        this.cubeSelection = new CubeSelection(this.context);
        this.updateSelectionUiRangeBounds();

        this.reconstructAllZoomFactors();
        this.context.rendering.resetForNewParameter();
        this.context.tileData.allocateTileStorages(cubeChanged);
        this.context.tileData.resetTileMaps();
        this.context.tileData.symmetricalColormapAroundZero = false;
        // this.colormapAllTiles();
        this.updateDatasetInfoAndShow(true, false);
        this.fullyLoaded = true;
        if (!this.cubeTags.includes(CubeTag.ColormappingFromObservedValues)) {
            this.htmlColormapMaxInputDiv.value = `${this.selectedParameter.globalMaximumValue}`;
            this.htmlColormapMinInputDiv.value = `${this.selectedParameter.globalMinimumValue}`;
        } else {
            this.htmlColormapMaxInputDiv.value = ``;
            this.htmlColormapMinInputDiv.value = ``;
        }
        if (this.selectedParameter.fixedColormapMaximumValue !== undefined) {
            this.htmlColormapMaxInputDiv.value = `${this.selectedParameter.fixedColormapMaximumValue}`;
        }
        if (this.selectedParameter.fixedColormapMinimumValue !== undefined) {
            this.htmlColormapMinInputDiv.value = `${this.selectedParameter.fixedColormapMinimumValue}`;
        }
        this.context.tileData.ignoreStatisticalColormapBounds = false;
        if (this.selectedParameter.fixedColormap !== undefined) {
            const flipped = (this.selectedParameter.fixedColormapFlipped !== undefined && this.selectedParameter.fixedColormapFlipped)
            this.htmlColormapFlippedCheckbox.checked = flipped
            this.context.tileData.colormapFlipped = flipped;
            this.selectColormapByName(this.selectedParameter.fixedColormap);
        } else {
            // reset colormap flipped
            if (!this.context.widgetMode) {
                this.htmlColormapFlippedCheckbox.checked = false
                this.context.tileData.colormapFlipped = false;
            }

            // select default colormap
            if (this.selectedParameter.isAnomalyParameter()) {
                this.context.tileData.symmetricalColormapAroundZero = true;
                this.context.tileData.ignoreStatisticalColormapBounds = true;
                this.selectColormapByName("balance");
            } else if (!this.context.widgetMode) { 
                this.selectArbitraryLinearColormap(this.htmlParameterSelect.options.selectedIndex + 2);
            }
        }
        this.context.rendering.updateVisibilityAndLods();
        this.updateColormapOverrideRangesFromUi();
        this.updateSlidersAndLabelsAfterChange();
        this.updateLabelPositions();
        this.parameterBeingSelected = false;
        this.initialLoad = false;
        return true;
    }
    
    async selectCube(logicalDataCube: LogicalDataCube) {
        this.context.log("Select cube", logicalDataCube.id)
        this.fullyLoaded = false;
        if (this.animationEnabled) {
            this.stopAnimation();   
        }
        if (this.context.orchestrationMasterMode && this.selectedCube) {
            this.context.networking.pushOrchestratorCubeUpdate(logicalDataCube.id);
        }
        this.htmlCubeSelect.value = logicalDataCube.id;
        this.selectedCube = logicalDataCube;
        const meta = await this.context.networking.fetch(`/api/datasets/${logicalDataCube.id}`);
        this.selectedCubeMetadata = meta;
        this.cubeParameters = new Map<string, Parameter>();
        for (let parameterId of Object.keys(meta["data_vars"])) {
            const parameterAttributionLookupId = parameterId.endsWith(ANOMALY_PARAMETER_ID_SUFFIX) ? parameterId.substring(0, parameterId.length - ANOMALY_PARAMETER_ID_SUFFIX.length) : parameterId;
            const attribution = this.getAttributionParameterMetadata(parameterAttributionLookupId);
            const parameter = new Parameter(parameterId, this.selectedCubeMetadata.data_vars[parameterId], attribution, this.getColormapParameterMetadata(parameterId));
            this.cubeParameters.set(parameterId, parameter);
        }

        if (this.gpsTrackingEnabled) {
            this.stopGps();
        }

        this.cubeTags = [];
        
        this.cubeDimensions = new CubeDimensions(
            this.context,
            meta.dims_ordered,
            meta.dims,
            meta.indices
        );

        const geospatialContext = new GeospatialContext();
        geospatialContext.setFromMetaInfo(meta);

        const hainich = this.selectedCube.shortName.indexOf("Hainich") > -1;
        const auwald = this.selectedCube.shortName.indexOf("Auwald") > -1;
        const esdc = this.selectedCube.id.indexOf("esdc") > -1;
        const esdc2 = this.selectedCube.id.indexOf("esdc-2") > -1;
        const esdc3 = this.selectedCube.id.indexOf("esdc-3") > -1;
        const camsEcmwf = this.selectedCube.id.indexOf("cams-eac4") > -1;
        const era5SpecificHumidity = this.selectedCube.id.indexOf("era5-specific-humidity") > -1;
        if (hainich || auwald) {
            this.cubeTags.push(CubeTag.SpectralIndices);
            this.cubeTags.push(CubeTag.ColormappingFromObservedValues);
        }
        if (this.context.widgetMode) {
            this.cubeTags.push(CubeTag.ColormappingFromObservedValues);
        }
        if (hainich) {
            this.cubeTags.push(CubeTag.Hainich);
            geospatialContext.latMin = -51.101795642012135;
            geospatialContext.latMax = -51.0566772412508;
            geospatialContext.lonMin = 10.4149020992527;
            geospatialContext.lonMax = 10.487933035725268;
            geospatialContext.geospatialResolution = 8.333333333333333e-4;
        }
        if (auwald) {
            this.cubeTags.push(CubeTag.Auwald);
            geospatialContext.latMin = -51.38971653210468;
            geospatialContext.latMax = -51.34204047701096;
            geospatialContext.lonMin = 12.274098103564866;
            geospatialContext.lonMax = 12.347526267533526;
            geospatialContext.geospatialResolution = 8.333333333333333e-4;
        }
        if (camsEcmwf) {
            this.cubeTags.push(CubeTag.Global);
            this.cubeTags.push(CubeTag.LongitudeZeroIndexIsGreenwich);
            this.cubeTags.push(CubeTag.ECMWF);
            this.cubeTags.push(CubeTag.CamsEac4Reanalysis);
        }
        if (era5SpecificHumidity) {
            this.cubeTags.push(CubeTag.Era5SpecificHumidity);
            this.cubeDimensions.z.units = "hPa";
        }
        if (esdc) {
            this.cubeTags.push(CubeTag.Global);
            this.cubeTags.push(CubeTag.ESDC);
            this.cubeTags.push(CubeTag.OverflowX);
        }
        if (esdc2) {
            this.cubeTags.push(CubeTag.ESDC2);
        }
        if (esdc3) {
            this.cubeTags.push(CubeTag.ESDC3);
        }
        if (this.cubeDimensions.x.type == CubeDimensionType.Longitude && this.cubeDimensions.y.type == CubeDimensionType.Latitude && this.cubeDimensions.x.getValueRange() > 350 && this.cubeDimensions.y.getValueRange() > 170) {
            this.context.log("X/Y are longitude/latitude with large value ranges, assuming cube is global.");
            this.cubeTags.push(CubeTag.Global);
            this.cubeTags.push(CubeTag.OverflowX);
            if (this.cubeDimensions.x.getMaxValue() > 350) {
                this.cubeTags.push(CubeTag.LongitudeZeroIndexIsGreenwich);
                this.context.log("Found longitude values > 350, will assume longitude zero index is Greenwich")
            }
        }
        if (this.cubeTags.includes(CubeTag.Global) && !geospatialContext.isValid()) {
            if (this.cubeDimensions.y.type != CubeDimensionType.Latitude) {
                console.warn("Y dimension is not Latitude, but trying to use it for guessing global coverage")
            }
            geospatialContext.guessFromGlobalCoverage(this.cubeDimensions.y.steps);
            this.context.log("Guessing geospatial context, assuming equally distributed global coverage")
        }
        this.geospatialContextProvided = geospatialContext.isValid();
        this.context.log("Geospatial context provided:", this.geospatialContextProvided);
        
        if (this.geospatialContextProvided) {
            this.cubeDimensions.setGeospatialContext(geospatialContext.latMin!, geospatialContext.latMax!, geospatialContext.lonMin!, geospatialContext.lonMax!);
        }
        this.context.log("Selected cube meta:", meta);
        // console.log(selectedCubeDimensions);
        this.context.rendering.updateOverflowSettings(this.cubeTags.includes(CubeTag.OverflowX), false, false);
        this.cubeDimensions.zParameterRange.set(0, this.cubeDimensions.z.steps - 1);
        this.cubeDimensions.yParameterRange.set(0, this.cubeDimensions.y.steps - 1);
        this.cubeDimensions.xParameterRange.set(0, this.cubeDimensions.x.steps - 1);
        this.XYdataAspectRatio = this.context.widgetMode ? 1.0 : this.cubeDimensions.x.steps / this.cubeDimensions.y.steps;
        this.context.log("Cube tags:", this.cubeTags.map(a => CubeTag[a]));
        this.updateAvailableParametersUi();

        this.updateSliderLabels();

        if (this.initialLoad && this.initialSelectionState.parameterId && this.parseInitialParameter()) {
            // parameter will be selected as side effect of parseInitialParameter
        } else if (this.cubeTags.includes(CubeTag.ESDC)) {
            this.selectParameter("air_temperature_2m", true);
        } else if (this.cubeTags.includes(CubeTag.CamsEac4Reanalysis)) {
            this.selectParameter("aod550", true);
        } else {
            this.selectParameter(this.cubeParameters.get(Array.from(this.cubeParameters.keys())[0])!.name, true);
        }
        if (!this.context.widgetMode) {
            this.updateUrlFragment();
        }
        this.context.log("done selecting cube and parameter, cubeselection:", this.cubeSelection)
    }

    private parseInitialParameter() {
        const s = Array.from(this.cubeParameters.keys()).find(s => s.toLowerCase() == this.initialSelectionState.parameterId);
        if (s) {
            return this.selectParameter(s, true);
        }
        return false;
    }

    applyCameraPreset(presetName: string = ""): void {
        let index = this.context.scriptedMultiViewMode ? 5 : 3;
        const urlPreset = document.URL.match(/camera=(\w+)/);
        if (presetName.length > 0) {
            index = this.cameraPresets.findIndex(c => c.name == presetName);
        } else if (urlPreset && urlPreset.length > 0) {
            index = this.cameraPresets.findIndex(c => c.name == `Single Face (${urlPreset[1]})`)
        }
        const c = this.cameraPresets[index];
        this.context.log("Applying camera preset", c.name);
        let position = c.position.clone();
        const rotation = c.rotation;
        if (this.context.isClientPortrait() && !this.context.rendering.printTemplateDownloading) {
            position = position.multiplyScalar(1.5);
        }
        if (!this.context.isometricMode) {
            position = position.multiplyScalar(1.0 + Math.max(0.0, (50 - (this.context.rendering.camera as any).fov) / 8.0));
        }
        this.context.rendering.camera.zoom = c.zoom || 1;
        this.context.rendering.camera.position.set(position.x, position.y, position.z);
        this.context.rendering.camera.rotation.set(rotation.x, rotation.y, rotation.z);
        this.context.rendering.camera.updateProjectionMatrix();
        if (!this.context.rendering.printTemplateDownloading) {
            this.orbitControls.update();
        }
        this.context.rendering.requestRender();
    }

    selectCubeById(cube_id: string) {
        this.findToSelectCube(cube_id);
    }    
    
    private async findToSelectCube(cube_id: string) {
        for (let c of this.availableCubes) {
            if (c.id.toLowerCase() == cube_id.toLowerCase()) {
                await this.selectCube(c);
                return true;
            }
        }
        this.context.log(`Cannot select cube ${cube_id}, does not exist`);
        return false;
    }

    private updateAvailableCubesUi() {
        const s = this.htmlCubeSelect.options.length;
        for (let i = 0; i < s; i++) {
            this.htmlCubeSelect.options.remove(0);        
        }

        for (const logicalDataCube of this.availableCubes) {
            let option = document.createElement("option");
            option.text = logicalDataCube.shortName;
            option.value = logicalDataCube.id;
            this.htmlCubeSelect.options.add(option);
        }
    }
    
    private async retrieveMetaData() {
        const status = await this.context.networking.fetch(`/api`);
        if (status["api_version"] != API_VERSION) {
            return console.error("Wrong API version on server");
        }
        this.availableCubes = await this.context.networking.fetch(`/api/datasets`);
        this.context.log("Available cubes: ", this.availableCubes);
        this.updateAvailableCubesUi();
    }

    private requestUrlFragmentUpdateTimeoutHandler = 0;
    private requestUrlFragmentUpdateTimeoutMilliseconds = 500;

    requestUrlFragmentUpdate() {
        if (this.requestUrlFragmentUpdateTimeoutHandler || this.context.widgetMode) {
            return; //window.clearTimeout(this.requestUrlFragmentUpdateTimeoutHandler);
        }
        this.requestUrlFragmentUpdateTimeoutHandler = window.setTimeout(() => { 
            this.updateUrlFragment();
            this.requestUrlFragmentUpdateTimeoutHandler = 0;
        }, this.requestUrlFragmentUpdateTimeoutMilliseconds);
    }

    initialSelectionState: SelectionState = new SelectionState();
    private urlFragmentStartSymbol = "!";
    private urlFragmentSplitSymbol = "/";

    private parseUrlFragment() {
        let t = decodeURIComponent(document.location.search);
        if (t.indexOf(this.urlFragmentStartSymbol) == -1) {
            return;
        }
        if (t[t.length - 1] == "=") {
            t = t.substring(0, t.length - 1);
        }
        try {
            const hash = t.split(this.urlFragmentStartSymbol)[1];
            const split = hash.split(this.urlFragmentSplitSymbol);
            this.context.log("Parsing url fragment:", hash, split);
            this.initialSelectionState.cubeId = split[0];
            this.initialSelectionState.parameterId = split[1];
            this.initialSelectionState.zRange = split[2].split("-").map(parseFloat);
            this.initialSelectionState.yRange = split[3].split("-").map(parseFloat);
            this.initialSelectionState.xRange = split[4].split("-").map(parseFloat);
        } catch (error) {
        }
    }

    private updateUrlFragment() {
        let query = decodeURIComponent(document.location.search);
        if (query.indexOf(this.urlFragmentStartSymbol) > -1) {
            query = query.substring(0, query.indexOf(this.urlFragmentStartSymbol));
        }
        const hash = this.urlFragmentStartSymbol + [this.selectedCube.id.toLowerCase(), this.selectedParameterId.toLowerCase(), this.cubeSelection.getSelectionRangeByDimension(Dimension.Z).toString(), this.cubeSelection.getSelectionRangeByDimension(Dimension.Y).toString(), this.cubeSelection.getSelectionRangeByDimension(Dimension.X).toString()].join(this.urlFragmentSplitSymbol);
        history.replaceState({}, "", query.length > 1 ? query + hash : "?" + hash);
    }

    private updateAvailableParametersUi() {
        this.htmlParameterSelect.innerHTML = "";

        const groups = new Map<string, string[]>();
        let groupMapper = (p: Parameter) => p.project || "Parameters";

        if (this.cubeTags.includes(CubeTag.CamsEac4Reanalysis)) {
            groupMapper = (p: Parameter) => {
                if (p.longName.toLowerCase().includes("vertically integrated"))  return "Vertically Integrated Masses"
                if (p.longName.toLowerCase().includes("total column")) return "Atmospheric Columns";
                if (p.longName.toLowerCase().includes("aerosol") || p.longName.toLowerCase().includes("particulate")) return "Aerosols";
                return "Meteorology";
            }
        }
        for (const parameter of this.cubeParameters.keys()) {
            const p = this.cubeParameters.get(parameter)!;
            const groupKey = groupMapper(p);
            if (groups.get(groupKey) !== undefined) {
                groups.get(groupKey)!.push(parameter);
            } else {
                groups.set(groupKey, [parameter]);
            }
        }

        let optgroup: HTMLOptGroupElement | undefined;
        const sortedKeys = Array.from(groups.keys()).sort();
        for (let key of sortedKeys) {
            const group = groups.get(key)!;
            if (groups.size != 1) {
                let optiongroup = document.createElement("optgroup");
                optiongroup.label = key;
                this.htmlParameterSelect.add(optiongroup);
                optgroup = optiongroup;
            }

            let elements = [];
            for (let parameterId of group) {
                let option = document.createElement("option");
                const parameter = this.cubeParameters.get(parameterId)!;
                const attributionMetadata = parameter.attributionMetadata;
                const suffix = parameter.isAnomalyParameter() ? " (Anomalies)" : "";
                if (this.cubeTags.includes(CubeTag.SpectralIndices)) {
                    option.text = parameterId;
                } else {
                    option.text = (attributionMetadata && attributionMetadata.long_name) ? attributionMetadata.long_name : (parameter!.longName || parameterId);
                }
                option.text += suffix;
                option.value = parameterId;
                this.htmlParameterSelect.add(option);
                elements.push(option);
            }
            if (optgroup) {
                elements.sort((a, b) => a.text < b.text ? -1 : 1);
                for (let element of elements) {
                    optgroup!.appendChild(element);
                }
            }
        }
    }

    updateDisplaySignificance() {
        const td = this.context.tileData;
        const n = 3 - Math.log10(this.selectedParameter.getConvertedDataValue(td.observedMaxValue) - this.selectedParameter.getConvertedDataValue(td.observedMinValue));
        if (isNaN(n)) {
            return;
        }
        const newSignificance = clamp(Math.round(n), 2, 32);
        if (newSignificance != this.floatDisplaySignificance) {
            // console.log(`New Display significance: ${newSignificance} (previously: ${floatDisplaySignificance})`)
            this.floatDisplaySignificance = newSignificance;
            this.updateColormapRangeUi();
            this.updateHoverInfoUi();
        }    
    }

    private initializeColormapScale() {
        const canvas = document.createElement("canvas");
        canvas.width = this.colormapScaleWidth;
        canvas.height = this.colormapScaleHeight;
        this.colormapScaleCanvasContext = canvas.getContext("2d")!;
        this.updateColormapScale(this.getColormapDataFromName(DEFAULT_COLORMAP));
        this.htmlColormapScaleGradient.appendChild(canvas);        
    }

    convertColormapDataToRGB8(source: number[][]) {
        const data: number[][] = JSON.parse(JSON.stringify(source));

        // double the amount of points by linearly interpolating --> increases colormap accuracy slightly
        const count = data.length;
        for (let i = 0; i < count - 1; i++) {
            const p0 = source[i];
            const p1 = source[i + 1];
            const p = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
            data.splice(i*2 + 1, 0, p);
        }

        for (let i = 0; i < data.length; i++) {
            data[i][0] = clamp(Math.round(data[i][0] * 255), 0, 255);
            data[i][1] = clamp(Math.round(data[i][1] * 255), 0, 255);
            data[i][2] = clamp(Math.round(data[i][2] * 255), 0, 255);
        }
        return data;
    }

    getColormapDataFromName(name: string) {
        const category = Object.keys(defaultColormaps).find(c => Object.keys((defaultColormaps as any)[c]).includes(name))!;
        const source = (defaultColormaps as any)[category][name] as number[][];      
        return this.convertColormapDataToRGB8(source);
    }

    private updateColormapScale(data: number[][]) {
        const gradient = this.colormapScaleCanvasContext.createLinearGradient(0, 0, this.colormapScaleWidth, 0);
        for (let i = 0; i < data.length; i++) {
            const p = i / (data.length - 1);
            const c = data[i];
            gradient.addColorStop(this.context.tileData.colormapFlipped ? 1.0 - p : p, `rgb(${c[0]}, ${c[1]}, ${c[2]})`);
        }
        this.colormapScaleCanvasContext.fillStyle = gradient;
        this.colormapScaleCanvasContext.fillRect(0, 0, this.colormapScaleWidth, this.colormapScaleHeight);
    }

    updateColormapScaleTexts(minValue: number, maxValue: number) {
        const count = this.htmlColormapScaleTexts.length;
        this.htmlColormapScaleUnitText.innerHTML = `${this.selectedParameter.getUnitHTML()}`;
        for (let i = 0; i < count; i++) {
            const p = i / (count - 1);
            this.htmlColormapScaleTexts[i].textContent = `${this.toFixed(this.selectedParameter.getConvertedDataValue(p * (maxValue - minValue) + minValue))}`;
        }
    }

    private initializeColormapUi() {
        const gradientResolution = 100;
        const canvas = document.createElement("canvas");
        canvas.height = 1;
        canvas.width = gradientResolution;
        const canvasContext = canvas.getContext("2d")!;
        
        const colormapCategories = Object.keys(defaultColormaps);
        for (let category of colormapCategories) {
            const colormapNames = Object.keys((defaultColormaps as any)[category]);
            for (let j = 0; j < colormapNames.length; j++) {
                const name = colormapNames[j];
                const data = this.getColormapDataFromName(name);
    
                const button = document.createElement("button");
                const gradient = canvasContext.createLinearGradient(0, 0, gradientResolution, 0);
                
                for (let i = 0; i < data.length; i++) {
                    const p = i / (data.length - 1);
                    const c = data[i]
                    gradient.addColorStop(p, `rgb(${c[0]}, ${c[1]}, ${c[2]})`);
                }
                
                canvasContext.fillStyle = gradient;
                canvasContext.fillRect(0, 0, gradientResolution, 1);
                let img_b64 = canvas.toDataURL('image/png');
                button.style.backgroundImage = `url(${img_b64})`
                button.onclick = () => { this.selectColormapByName(name); }
                button.title = name;
                this.htmlColormapButtonList.appendChild(button);
            }
        }
    }

    private selectArbitraryLinearColormap(parameterIndex: number) {
        const names = ["viridian","algae","deep","dense","haline","ice","speed","tempo","turbid"]
        this.selectColormapByName(names[parameterIndex % names.length]);
    }

    selectColormapByName(name: string) {
        const category = Object.keys(defaultColormaps).find(c => Object.keys((defaultColormaps as any)[c]).includes(name))!;
        if (!category) {
            console.error("Cannot find colormap", name);
            return false;
        }
        this.selectedColormapCategory = category;

        this.selectedColormapName = name;
        this.context.log("selectColormapByName", name, this.selectedColormapCategory);

        const selected = "selected";
        for (let i = 0; i < this.htmlColormapButtonList.children.length; i++) {
            const element = this.htmlColormapButtonList.children[i] as HTMLButtonElement;
            if (name == element.title) {
                element.classList.add(selected);
            } else {
                element.classList.remove(selected);
            }
        }
        this.updateColormapScale(this.getColormapDataFromName(name));
        this.context.tileData.selectColormapByName(name);
        return true;
    }

    selectColormapByData(data: number[][]) {
        this.selectedColormapName = "Custom Colormap";
        this.selectedColormapCategory = "Custom";
        this.updateColormapScale(data);
        this.context.tileData.selectColormapByData(data);
        return true;
    }

    private getDisplaySizeBounds(face: CubeFace) {
        let width = this.cubeDimensions.xParameterRangeForFace(face).length();
        let height = this.cubeDimensions.yParameterRangeForFace(face).length();
        const dataAspectRatio = (face == CubeFace.Front || face == CubeFace.Back || face == CubeFace.Top || face == CubeFace.Bottom) ? this.XYdataAspectRatio : 1.0;
        const minDisplaySize = new Vector2(width * Math.pow(0.5, MAX_ZOOM_FACTOR) / dataAspectRatio, height * Math.pow(0.5, MAX_ZOOM_FACTOR));
        const maxDisplaySize = new Vector2(this.roundDownToSparsity(width / dataAspectRatio), this.roundDownToSparsity(height));
        return { maxDisplaySize, minDisplaySize };
    }

    private changeZoomOnFace(zoomDelta: number, face: CubeFace, focusUv: Vector2, immediate: boolean = false) {
        this.reconstructZoomFactor(face, true);
        const displaySizeBounds = this.getDisplaySizeBounds(face);
        const newDisplaySize = displaySizeBounds.maxDisplaySize.clone();

        const oldDisplaySize = this.cubeSelection.getSizeVector(face);
        const oldDisplayOffset = this.cubeSelection.getOffsetVector(face);
        const newDisplayOffset = oldDisplayOffset.clone();

        // per 200 zoomDelta, halve visible dimensions
        const previousZoomFactor = this.currentZoomFactor[Math.floor(face / 2)];
        this.currentZoomFactor[Math.floor(face / 2)] = clamp(this.currentZoomFactor[Math.floor(face / 2)] + (zoomDelta / 200), 1.0, MAX_ZOOM_FACTOR);
        const zoomFactor = Math.pow(0.5, this.currentZoomFactor[Math.floor(face / 2)] - 1.0);
        const zoomFactorDifference = Math.abs(this.currentZoomFactor[Math.floor(face / 2)] - previousZoomFactor);
        const zoomFactorChanged = Math.abs(zoomFactorDifference) > 0.01;
        let newCenterPoint = new Vector2();
        const oldCenterPoint = oldDisplayOffset.clone().add(oldDisplaySize.clone().multiplyScalar(0.5));
        if (immediate) {
            let normalizeFactor = 1.0;
            if (Math.sign(zoomDelta) == 1) { // zoom in 
                normalizeFactor = 1.0;
            } else { // zoom out
                normalizeFactor = 2.0;
            }
            newCenterPoint = oldDisplayOffset.clone().add(oldDisplaySize.clone().multiply(focusUv.clone().addScalar(0.5 * normalizeFactor).divideScalar(normalizeFactor + 1)));
        } else {
            if (!this.currentZoomNewCenterPoint || !this.currentZoomOldCenterPoint) {
                this.currentZoomOldCenterPoint = oldDisplayOffset.clone().add(oldDisplaySize.clone().multiplyScalar(0.5));
                this.currentZoomNewCenterPoint = oldDisplayOffset.clone().add(oldDisplaySize.clone().multiply(focusUv));
            }
            const zoomFactorDistance = clamp(zoomFactorDifference, 0.0, 2.0);
            const p = zoomFactorDistance / 2.0;
            newCenterPoint = this.currentZoomOldCenterPoint.clone().multiplyScalar(1-p).add(this.currentZoomNewCenterPoint.clone().multiplyScalar(p));
        }

        // WIP: keep manually chosen aspect ratios; but no way to "leave it"
        // const aspectRatioDifference = 1.0 + oldDisplaySize.x / oldDisplaySize.y - maxDisplaySize.x / maxDisplaySize.y;
        // const aspectRatio = new Vector2(aspectRatioDifference < 1 ? aspectRatioDifference : 1.0, aspectRatioDifference > 1 ? 1.0 / aspectRatioDifference : 1.0);
        // //const f = new Vector2(previousAspectRatio, 1.0);
        // console.log(aspectRatioDifference, aspectRatio);
        // newDisplaySize.multiply(aspectRatio);

        newDisplaySize.multiplyScalar(zoomFactor).clamp(displaySizeBounds.minDisplaySize, displaySizeBounds.maxDisplaySize);

        // on side faces, only zoom into time
        if (face == CubeFace.Left || face == CubeFace.Right || face == CubeFace.Top || face == CubeFace.Bottom) {
            newDisplaySize.x = oldDisplaySize.x;
        }

        const relativeOffset = newDisplaySize.clone().multiplyScalar(0.5);
        const centerPoint = zoomFactorChanged ? newCenterPoint : oldCenterPoint;
        newDisplayOffset.copy(centerPoint).sub(relativeOffset);

        if (this.cubeTags.includes(CubeTag.Global) && (face == CubeFace.Front || face == CubeFace.Back || face == CubeFace.Top || face == CubeFace.Bottom)) {
            newDisplayOffset.y = clamp(newDisplayOffset.y, this.getMinimumDisplayOffset(face).y, this.getMaximumDisplayOffset(face, newDisplaySize).y)
            newDisplayOffset.x = this.normalizeOverflowingXValue(newDisplayOffset.x, face);
        } else {
            newDisplayOffset.clamp(this.getMinimumDisplayOffset(face), this.getMaximumDisplayOffset(face, newDisplaySize))
        }

        if (immediate) {
            this.cubeSelection.setVectors(face, newDisplaySize, newDisplayOffset);
        } else {
            this.cubeSelection.setVectorsNoRounding(face, newDisplaySize, newDisplayOffset);
            this.interactionFinishFace = face;
            this.interactionFinishDisplaySize = newDisplaySize;
            this.interactionFinishDisplayOffset = newDisplayOffset;
        }
    }

    reconstructAllZoomFactors() {
        for (let face = 0; face < 3; face++) {
            this.reconstructZoomFactor(face * 2);
        }
    }

    reconstructZoomFactor(face: CubeFace, onlyAssignIfDifferent: boolean = false) {
        const maxDisplaySize = this.getDisplaySizeBounds(face).maxDisplaySize;
        const displaySize = this.cubeSelection.getSizeVector(face).clone().divide(maxDisplaySize);
        
        const newZoomFactor = clamp(1.0 - Math.log2(Math.min(displaySize.x, displaySize.y)), 1.0, MAX_ZOOM_FACTOR);
        const zoomFactorDifference = Math.abs(newZoomFactor - this.currentZoomFactor[Math.floor(face / 2)]);
        if (!onlyAssignIfDifferent || (zoomFactorDifference > 0.3)) {
            this.currentZoomFactor[Math.floor(face / 2)] = newZoomFactor;
            this.context.log("Reconstructed zoom factor", newZoomFactor, "for face", CubeFace[face]);
        }
    }

    roundToSparsity(value: number) {
        return Math.round(value / this.selectedCubeMetadata.sparsity) * this.selectedCubeMetadata.sparsity;
    }

    roundUpToSparsity(value: number) {
        return Math.ceil(value / this.selectedCubeMetadata.sparsity) * this.selectedCubeMetadata.sparsity;
    }

    roundDownToSparsity(value: number) {
        return Math.floor(value / this.selectedCubeMetadata.sparsity) * this.selectedCubeMetadata.sparsity;
    }

    getMinimumDisplayOffset(face: CubeFace) {
        const xRange = this.cubeDimensions.xParameterRangeForFace(face);
        const yRange = this.cubeDimensions.yParameterRangeForFace(face);
        return new Vector2(xRange.min, yRange.min);
    }

    getMaximumDisplayOffset(face: CubeFace, displaySize: Vector2) {
        const xRange = this.cubeDimensions.xParameterRangeForFace(face);
        const yRange = this.cubeDimensions.yParameterRangeForFace(face);
        return new Vector2(xRange.max - displaySize.x, yRange.max - displaySize.y);
    }

    getVisibleFaces() {
        const result = [];
        for (let face = 0; face < 6; face++) {
            const visible = this.context.rendering.faceVisibility[face];
            if (!visible) { // maybe instead prioritize by visibility?
                continue;
            }
            result.push(face);
        }
        return result;
    }

    getVisibleTiles() {
        const tiles: Tile[] = [];
        for (let face = 0; face < 6; face++) {
            const visible = this.context.rendering.faceVisibility[face];
            if (!visible) { // maybe instead prioritize by visibility?
                continue;
            }
            const lod = this.context.rendering.lods[face];
            
            // const key = "(indexValue), lodValue, tileX, tileY"
            const d = TILE_SIZE * Math.pow(2, lod);
            let xValues: number[] = [];

            const width = this.cubeDimensions.totalWidthForFace(face);
            const maxX = Math.ceil(width / d) - 1;

            const offset = this.cubeSelection.getOffsetVector(face);
            // if (face == CubeFace.Front || face == CubeFace.Back || face == CubeFace.Top || face == CubeFace.Bottom) {
            //     offset.x = positiveModulo(offset.x, width);
            // }
            const size = this.cubeSelection.getSizeVector(face);
            const minVisibleY = Math.floor(offset.y / d);
            const maxVisibleY = Math.floor((offset.y + size.y - 1) / d);
            const minVisibleX = Math.floor(positiveModulo(offset.x, width) / d);
            const maxVisibleX = Math.floor(positiveModulo(offset.x + size.x - 1, width) / d);
            const xOverflown = Math.floor(offset.x / width) < Math.floor((offset.x + size.x) / width);
            if ((face == CubeFace.Front || face == CubeFace.Back || face == CubeFace.Top || face == CubeFace.Bottom) && (xOverflown)) {
                xValues = range(minVisibleX, maxX).concat(range(0, maxVisibleX))
            } else {
                xValues = range(minVisibleX, maxVisibleX);
            }

            for (let x of xValues) {
                for (let y = minVisibleY; y <= maxVisibleY; y++) {
                    tiles.push(new Tile(face, this.cubeSelection.getIndexValueForFace(face), lod, x, y, this.selectedCube.id, this.selectedParameterId));
                }
            }
        }
        return tiles;
    }

    async triggerTileDownloads() {
        for (let face = 0; face < 6; face++) {
            const newIndexValue = this.cubeSelection.getIndexValueForFace(face);
            if (this.lastIndexValue[face] != newIndexValue) {
                this.context.tileData.resetTileDownloadMapsForFace(face);
                this.lastIndexValue[face] = newIndexValue;
            }
        }
        const visibleTiles = this.getVisibleTiles();
        const tilesToDownload = visibleTiles.filter(t => !this.context.tileData.isTileDownloadTriggered(t));
        if (tilesToDownload.length > 0) {
            this.context.networking.downloadTiles(tilesToDownload);
        }

        if (tilesToDownload.length == 0) {
            this.context.rendering.setAllTilesDownloaded();
        } else {
            this.renderedAfterAllTilesDownloaded = false;
        }
        // this.context.log(`Triggered ${tilesToDownload.length} tile downloads`)
        
        const finishedTiles = visibleTiles.filter(t => this.context.tileData.isTileDownloadFinished(t))
        const faces = this.getVisibleFaces();
        for (let face of faces) {
            if (finishedTiles.filter(t => t.face == face).length == visibleTiles.filter(t => t.face == face).length) {
                // exceptional LoD refresh for when all tiles are already downloaded (also: maybe LoD has not changed but it's okay)
                this.context.rendering.revealLodForFace(face);
            }
        }
    }
    
    private parseEuropeanDate(dateString: string): Date { // Parses DD.MM.YYYY
        const split = dateString.split(/(\-|\.|\/)/);
        return new Date(`${split[2]}-${split[0]}-${split[4]}`);
    }

    getAvailableCubes() {
        return this.availableCubes;
    }

    getAvailableParameters() {
        return Array.from(this.htmlParameterSelect.options).map(o => o.value);;
    }
    
    getRenderedAfterAllTilesDownloaded() {
        // console.log("get", this.renderedAfterAllTilesDownloaded)
        return this.renderedAfterAllTilesDownloaded;
    }

    resetRenderedAfterAllTilesDownloaded() {
        // console.log("reset")
        this.renderedAfterAllTilesDownloaded = false;
    }

    setRenderedAfterAllTilesDownloaded() {
        this.renderedAfterAllTilesDownloaded = true;
        if (this.animationEnabled) {
            this.attemptNextAnimationStep();
        }
        if (this.context.rendering.printTemplateDownloading) {
            this.context.rendering.processNextFaceForPrintTemplate();
        }
    }

    private attemptNextAnimationStep() {
        if (this.animationCurrentStep >= this.animationTotalSteps) {
            this.stopAnimation();
            return;
        }        
        this.animationCurrentStep += 1;
        const lastStepTime = performance.now() - this.animationLastStepTime;
        const targetTime = 1.0 / this.animationTargetFps * 1000.0;
        const w = Math.max(0, targetTime - lastStepTime); 
        if (w > 0) {
            window.setTimeout(this.nextAnimationStep.bind(this), w)
        } else {
            this.nextAnimationStep();
        }
        const lastFrameTime = performance.now() - this.animationLastFrameTime;
        // console.log(performance.now(), "last frame time:", lastFrameTime, "last step time", lastStepTime);
        this.animationLastFrameTime = performance.now();
    }

    private nextAnimationStep() {
        this.animationLastStepTime = performance.now();
        if (this.animationTimeIncrementPerStep == -1) {
            const timeMax = this.cubeDimensions.zParameterRange.length();
            const targetSteps = timeMax / this.selectedCubeMetadata.sparsity;
            this.animationVisibleTimeWindow = this.roundToSparsity(timeMax / 5.0);
            this.animationTimeIncrementPerStep = Math.max(this.roundToSparsity((timeMax - this.animationVisibleTimeWindow) / targetSteps), this.selectedCubeMetadata.sparsity);
            this.animationTotalSteps = Math.floor((timeMax - this.animationVisibleTimeWindow) / this.animationTimeIncrementPerStep);
            this.context.log("First animation frame: Time increment is", this.animationTimeIncrementPerStep, "Total step is", this.animationTotalSteps)
        }
        const a = this.animationTimeIncrementPerStep * this.animationCurrentStep;
        const min = this.roundUpToSparsity(this.cubeDimensions.zParameterRange.min + a);
        const max = this.roundDownToSparsity(min + this.animationVisibleTimeWindow);
        // if (max > this.cubeDimensions.timeParameterRange.max) {
        //     console.warn("Yep this is not going to work", max, this.cubeDimensions.timeParameterRange.max)
        // }
        this.cubeSelection.setRange(Dimension.Z, min, max);
        this.updateSlidersAndLabelsAfterChange();
        this.context.rendering.updateVisibilityAndLods();
    }
    
    getColormapMinMaxValuePrecision() {
        if (this.cubeTags.includes(CubeTag.SpectralIndices)) {
            return 1;
        }
        if (this.cubeTags.includes(CubeTag.Era5SpecificHumidity) && !this.selectedParameter.isAnomalyParameter()) {
            return 2;
        }
        return Infinity;
    }


    updateRequestProgressFromWidget(progress: number[]) {
        const done = progress[0];
        const total = progress[1];
        this.updateStatusMessage(done, total, 0, 0);
    }

    showPrintTemplateLoader() {
        this.htmlPrintTemplateResultWrapper.style.display = "flex";
        this.htmlPrintTemplateLoadingSection.style.display = "flex";
        if (this.htmlPrintTemplateLoaderVideo) {
            this.htmlPrintTemplateLoaderVideo.play();
        }
        this.htmlPrintTemplateResultSection.style.display = "none";
    }

    private htmlPrintTemplateFirstNote: boolean = true;

    async showPrintTemplateResult(svg: string) {
        this.context.log("Creating QR code link");
        if (this.context.widgetMode) {
            svg = svg.replace("Link to your cube:", "");
        } else {
            const qr = await QRCode.toDataURL(document.URL, { color: { dark: "#000", light: "#ffffff00" } });
            svg = svg.replace("qrcode.png", qr);
        }
        let datasetName = this.selectedCube.shortName;
        if (datasetName.startsWith("<class")) {
            datasetName = datasetName.substring(datasetName.lastIndexOf(".") + 1, datasetName.length - 2);
        }
        svg = svg.replace("%dataset%", datasetName);
        svg = svg.replace("%parameter%", this.selectedParameter.longName || this.selectedParameter.name);

        this.htmlPrintTemplateFirstNote = true;

        this.htmlPrintTemplateDownloadEditNoteButton.innerText = "Add a custom note";
        this.htmlPrintTemplateDownloadEditNoteButton.onclick = () => {
            const input = window.prompt(this.htmlPrintTemplateFirstNote ? "Add a custom note:" : "Edit your custom note:") || "";
            if (input == "") {
                return;
            }
            const sanitizedInput = new Option(input).innerHTML;
            let newSvg = svg.replace("%note%", sanitizedInput);
            newSvg = newSvg.replace("display:none;", "");

            this.htmlPrintTemplateDownloadEditNoteButton.innerText = "Edit your custom note";
            this.htmlPrintTemplateFirstNote = false;

            this.showNewPrintTemplateResult(newSvg);
        }
        this.showNewPrintTemplateResult(svg);
    }

    async showNewPrintTemplateResult(svg: string) {
        if (this.context.widgetMode) {
            this.htmlPrintTemplateResult.style.maxHeight = "300px";
        }
        if (this.htmlPrintTemplateDownloadButtonSvg.href) {
            URL.revokeObjectURL(this.htmlPrintTemplateDownloadButtonSvg.href);
        }
        this.context.log("Creating print template SVG and PNG");
        let reader = new FileReader();
        reader.readAsDataURL(new Blob([svg], { type: 'image/svg+xml' }));
        reader.onload = (e) => {
            const svgUrl = e.target?.result as string;
            this.htmlPrintTemplateDownloadButtonSvg.href = svgUrl;
            this.htmlPrintTemplateDownloadButtonSvg.download = `${this.context.interaction.selectedCube.id}-${this.context.interaction.selectedParameterId}-print-template.svg`;
            this.htmlPrintTemplateDownloadButtonPng.href = "";
    
            const svgImage = document.createElement('img');
            svgImage.crossOrigin = "anonymous";
            svgImage.style.maxWidth = "100%";
            svgImage.style.height = "100%";
            svgImage.style.backgroundColor = "white";
            this.htmlPrintTemplateResult.innerHTML = "";
            this.htmlPrintTemplateResult.appendChild(svgImage);
            const start = performance.now();
            svgImage.onload = () => {
                this.context.log("SVG loaded, took", performance.now() - start, "ms from start")
                const canvas = document.createElement('canvas');
                canvas.width = 3000;
                canvas.height = 4000;
                const canvasCtx = canvas.getContext('2d')!;
                canvasCtx.fillStyle = "white";
                canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
                canvasCtx.drawImage(svgImage, 0, 0, canvas.width, canvas.height);
    
                this.htmlPrintTemplateLoadingSection.style.display = "none";
                this.htmlPrintTemplateResultSection.style.display = "flex";
                
                const imgData = canvas.toDataURL('image/png');
                this.htmlPrintTemplateDownloadButtonPng.href = imgData;
                this.htmlPrintTemplateDownloadButtonPng.download = `${this.context.interaction.selectedCube.id}-${this.context.interaction.selectedParameterId}-print-template.png`;
                this.context.log("Print template all done (SVG + PNG), took", performance.now() - start, "ms from start")
            };
            svgImage.src = svgUrl;
        }
    }

    async getPrintTemplateSvg() {
        if (this.context.widgetMode) {
            return this.getHtmlElementByClassName("print-template-wrapper").innerHTML;
        } else {
            return await (await fetch("paper-cube-template-v3.svg")).text();
        }
    }
}

export { CubeInteraction }