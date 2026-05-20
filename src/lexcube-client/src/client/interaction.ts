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

import { Camera, Euler, Event, Intersection, IUniform, Object3D, OrthographicCamera, PerspectiveCamera, Ray, Raycaster, Vector2, Vector3 } from 'three'
import { clamp, lerp } from 'three/src/math/MathUtils';
import { CubeFace, Dimension, MAX_ZOOM_FACTOR, positiveModulo, range, TILE_SIZE_2D, API_VERSION, capitalizeString, ANOMALY_PARAMETER_ID_SUFFIX, DEFAULT_COLORMAP, TILE_SIZE_3D, roundDownToSparsity, roundUpToSparsity, roundToSparsity, DataType, WATER_RELATED_VARIABLE_KEYWORDS, MAXIMUM_SUPPORTED_LOD, FLOAT_NAN_REPLACEMENT_VALUE, roundToSparsityWithinRange, debounce, RaycastResultType, DeviceOrientation, HALF_FLOAT_NAN_REPLACEMENT_VALUE, NON_EXTREME_QUANTILE_INDEX, QUANTILE_STEP, QUANTILE_RELEVANT_DECIMALS } from './constants';
import { CubeClientContext } from './client';
import { Tile2D, Tile3D, Tile3DClipBoundary, TileData } from './tiledata';
import { CameraControls } from './interaction/camera-controls';
import {
    CubeDimension,
    CubeDimensions,
    CubeDimensionType,
    CubeTag,
    GeospatialContext,
    GeospatialContextCorrection,
    GeospatialRange,
    ParameterRange,
    getDayString,
    getTimeString,
} from './core/dimensions';
import {
    Parameter,
    ParameterAttributionMetadata,
    ParameterColormapMetadata,
} from './core/parameters';
import {
    CubeSelection,
    SelectionState,
} from './core/selection';
import { AnimationParameters } from './core/animation';
import 'polyfill-array-includes';
import QRCode from 'qrcode'
import Chart, { Tooltip, TooltipModel } from 'chart.js/auto';


import parameterAttributionMetadata from '../content/parameterMetadataAttribution.json'
import parameterCustomColormapsMetadata from '../content/parameterCustomColormaps.json'
import { CubeRendering } from './rendering';
import { ActiveElement } from 'chart.js/dist/plugins/plugin.tooltip';
import { ColormapUIManager, ColormapUIHostState } from './ui/colormap-ui';
import { SliderUIManager, SliderUIHostState } from './ui/slider-ui';
import { AnimationUIManager, AnimationUIHostState } from './ui/animation-ui';
import { DataValue } from './services/tile-storage';

enum ContextLayerInteraction {
    Click,
    HoverEnter,
    HoverLeave,
}

enum ExtremeThresholdTarget {
    Observations,
    DeviationsFromMSC
}

enum ExtremeThresholdType {
    Absolute,
    Quantile
}

enum ExtremeSpatialQuantileContext {
    AllTimeSeries,
    PcaGroupedTimeSeries,
    SingleTimeSeries
}

class ExtremeType {
    readonly id: number;
    readonly name: string;
    readonly thresholdTarget: ExtremeThresholdTarget;
    readonly thresholdType: ExtremeThresholdType;
    readonly spatialQuantileContext: ExtremeSpatialQuantileContext | null;

    constructor(id: number, name: string, thresholdTarget: ExtremeThresholdTarget, thresholdType: ExtremeThresholdType, spatialQuantileContext: ExtremeSpatialQuantileContext | null = null) {
        this.id = id;
        this.name = name;
        this.thresholdTarget = thresholdTarget;
        this.thresholdType = thresholdType;
        this.spatialQuantileContext = spatialQuantileContext;
    }
}


// GeospatialContextCorrection moved to core/dimensions.ts

class TimeSeries {
    static nextId: number = 1;
    id: number;
    face: CubeFace;
    x: number;
    y: number;
    data: number[];
    labels: string[]; 
    marker: Object3D | undefined;
    pointColor: string;
    private insertedDataLength: number = 0;

    constructor(face: CubeFace, x: number, y: number, pointColor: string) {
        this.id = TimeSeries.nextId++;
        this.face = face;
        this.x = x;
        this.y = y;
        this.data = [];
        this.pointColor = pointColor;
        this.labels = [];
    }

    getPointColor() {
        return this.pointColor;
    }

    insertData(newData: number[], zStart: number, cubeInteraction: CubeInteraction) {
        const insertedLength = Math.min(newData.length, this.data.length - zStart);
        this.insertedDataLength += insertedLength;
        this.data.splice(zStart, insertedLength, ...newData.slice(0, insertedLength).map((b) => cubeInteraction.getConvertedDataValue(b)));
        return this.insertedDataLength >= this.data.length;
    }

    getRequestedDataRange() {
        return {
            indexDimension: Dimension.X,
            globalX: this.x,
            globalY: this.y,
        }
    }
}

// AnimationParameters moved to core/animation.ts
// GeospatialContext moved to core/dimensions.ts

class PickedDataValue {
    face: CubeFace | undefined;
    dataValue: number | Uint8Array;
    isDataValueNotLoaded: boolean;
    isDataNan: boolean | boolean[];
    x: number;
    y: number;
    z: number;
    lod: number;
    tileX: number;
    tileY: number;
    tileZ: number | undefined;
    localTilePixelX: number;
    localTilePixelY: number;
    localTilePixelZ: number | undefined;
    maximumCompressionError: number | undefined;

    constructor() {
        this.dataValue = 0;
        this.isDataValueNotLoaded = false;
        this.isDataNan = false;
        this.y = 0;
        this.x = 0;
        this.z = 0;
        this.lod = 0;
        this.tileX = 0;
        this.tileY = 0;
        this.localTilePixelX = 0;
        this.localTilePixelY = 0;
        this.maximumCompressionError = 0;
    }

    setFrom2dTileData(cubeSelection: CubeSelection, cubeDimensions: CubeDimensions, rendering: CubeRendering, tileData: TileData, selectedCubeId: string, selectedParameterId: string, face: number, uv: Vector2) {
        const offset = cubeSelection.getDisplayOffsetVector2d(face).clone();
        const size = cubeSelection.getDisplaySizeVector2d(face).clone();
        const hoverPosition = size.multiply(uv).add(offset);
        hoverPosition.x = positiveModulo(hoverPosition.x, cubeDimensions.totalWidthForFace(face))
        const lod = rendering.lods2d[face];

        const lodAdjustedTileSize = (Math.pow(2, lod) * TILE_SIZE_2D);
        const tileX = Math.floor(hoverPosition.x / lodAdjustedTileSize);
        const tileY = Math.floor(hoverPosition.y / lodAdjustedTileSize);
        const uvWithinTileX = (hoverPosition.x % lodAdjustedTileSize) / lodAdjustedTileSize;
        const uvWithinTileY = (hoverPosition.y % lodAdjustedTileSize) / lodAdjustedTileSize;
        const pixelX = Math.floor(uvWithinTileX * TILE_SIZE_2D);
        const pixelY = Math.floor(uvWithinTileY * TILE_SIZE_2D);
        const dv = tileData.getTile2dDataValue(face, lod, tileX, tileY, pixelX, pixelY);

        this.x = (face <= 3) ? hoverPosition.x : cubeSelection.getGuaranteedSparsityValidIndexValueForFace(face);
        this.y = (face > 3) ? hoverPosition.x : ((face <= 1) ? hoverPosition.y : cubeSelection.getGuaranteedSparsityValidIndexValueForFace(face));
        this.z = (face > 1) ? hoverPosition.y : cubeSelection.getGuaranteedSparsityValidIndexValueForFace(face);
        this.face = face;
        this.tileX = tileX;
        this.tileY = tileY;
        this.tileZ = undefined;
        this.localTilePixelX = pixelX;
        this.localTilePixelY = pixelY;
        this.localTilePixelZ = undefined;
        this.lod = lod;

        const tile = new Tile2D(face, (face <= 1 ? this.z : (face <= 3 ? this.y : this.x)), lod, tileX, tileY, selectedCubeId, selectedParameterId);

        return this.setFromDataValue(tileData, dv, tile);
    }

    setFrom3dTileData(globalVoxelPosition: Vector3, lod: number, cubeDimensions: CubeDimensions, tileData: TileData, selectedCubeId: string, selectedParameterId: string) {
        // const offset = cubeSelection.getDisplayOffsetVector3d().clone();
        // const size = cubeSelection.getDisplaySizeVector3d().clone();
        globalVoxelPosition.x = positiveModulo(globalVoxelPosition.x, cubeDimensions.totalWidthForFace(CubeFace.Front));

        const lodAdjustedTileSize = (Math.pow(2, lod) * TILE_SIZE_3D);
        const tileCoords = globalVoxelPosition.clone().divideScalar(lodAdjustedTileSize).floor();
        const uvWithinTile = globalVoxelPosition.clone().divideScalar(lodAdjustedTileSize);
        uvWithinTile.sub(uvWithinTile.clone().floor());
        const pixelWithinTileCoords = uvWithinTile.clone().multiplyScalar(TILE_SIZE_3D).floor();
        const dv = tileData.getTile3dDataValue(lod, tileCoords.x, tileCoords.y, tileCoords.z, pixelWithinTileCoords.x, pixelWithinTileCoords.y, pixelWithinTileCoords.z);

        this.x = globalVoxelPosition.x;
        this.y = globalVoxelPosition.y;
        this.z = globalVoxelPosition.z;
        this.face = undefined;
        this.tileX = tileCoords.x;
        this.tileY = tileCoords.y;
        this.tileZ = tileCoords.z;
        this.localTilePixelX = pixelWithinTileCoords.x;
        this.localTilePixelY = pixelWithinTileCoords.y;
        this.localTilePixelZ = pixelWithinTileCoords.z;
        this.lod = lod;

        const tile = new Tile3D(lod, tileCoords.x, tileCoords.y, tileCoords.z, selectedCubeId, selectedParameterId);

        this.setFromDataValue(tileData, dv, tile);
    }

    isFrom3d() {
        const is3d = this.tileZ !== undefined && this.localTilePixelZ !== undefined && this.face === undefined;
        const is2d = this.tileZ === undefined && this.localTilePixelZ === undefined && this.face !== undefined;
        if (!is3d && !is2d) {
            console.error("PickedDataValue is neither from 2d nor 3d tile data. This should not happen.");
        }
        return is3d;
    }

    private setFromDataValue(tileData: TileData, dv: DataValue, tile: Tile2D | Tile3D) {
        this.maximumCompressionError = tileData.maxCompressionErrors.get(tile.getHashKey());
        
        this.dataValue = dv.value;
        this.isDataValueNotLoaded = dv.isDataNotLoaded;
        this.isDataNan = dv.isDataNan;

        return this;
    }

    // getValue(cubeInteraction: CubeInteraction, selectedParameter: Parameter) {
    //     if (this.isDataValueNotLoaded) {
    //         return NaN;
    //     } else if (typeof this.dataValue === "number") {
    //         if (isNaN(this.dataValue) || this.isDataNan) {
    //             return NaN;
    //         }
    //         return cubeInteraction.toFixedNumber(selectedParameter.getConvertedDataValue(this.dataValue));
    //     } else if (this.dataValue instanceof Uint8Array) {
    //         return this.dataValue[0];
    //     }
    //     throw new Error("No valid value for picked data value.");
    // }

    getString(cubeInteraction: CubeInteraction, selectedParameter: Parameter, prefix: string = "") {
        if (this.isDataValueNotLoaded) {
            return `${prefix}Data not yet loaded`;
        } else if (typeof this.dataValue === "number") {
            if (isNaN(this.dataValue) || this.isDataNan) {
                return `${prefix}No Data`;
            } else {
                const value = `${cubeInteraction.toFixed(selectedParameter.getConvertedDataValue(this.dataValue))}`;
                return `${prefix}${value} ${selectedParameter.getUnitHTML()}`;
            }
        } else if (this.dataValue instanceof Uint8Array) {
            const lines = selectedParameter.getRgbDataValueString(this.dataValue, this.isDataNan);
            return lines;
        }
        return "No valid string for picked data value.";
    }
}


// SelectionState, CubeSelection moved to core/selection.ts
// CubeDimensionType, getDayString, getTimeString moved to core/dimensions.ts

const CSS_TURN_RED_FILTER = "brightness(0) saturate(100%) invert(37%) sepia(72%) saturate(6374%) hue-rotate(344deg) brightness(122%) contrast(117%)";

// CubeDimension, CubeDimensions moved to core/dimensions.ts
// Parameter, ParameterColormapMetadata, ParameterAttributionMetadata moved to core/parameters.ts
// GeospatialRange and ParameterRange moved to core/dimensions.ts

class LogicalDataCube {
    id!: string
    shortName!: string;
}

// CubeTag moved to core/dimensions.ts

class CubeInteraction {
    private context: CubeClientContext;
    updateUiDuringInteractions = {
        sliders: false,
        orbitControls: false,
    };

    private cameraPresets = [
        { name: "Diagonal Close-up South America", position: new Vector3(0.7334182744080036, -0.1937720441909164, 0.23593831568307924), rotation: new Euler(0.6875841168575725, 1.17633108419973, -0.6487348071441518, 'XYZ') },
        { name: "Full Earth - Front", position: new Vector3(2.080720175325273, 6.61750251743031e-17, 6.61750251743031e-17), rotation: new Euler(-6.162975822039155e-33, 1.5707963267948966, 0) },
        { name: "Look at right side", position: new Vector3(0.005694911428844007, 0.030379652376199662, -1.1831101491937133), rotation: new Euler(-3.115920506235054, 0.004811885820327965, 3.1414690954800735) },
        { name: "Tilted, front/left/top", position: new Vector3(1.795268175811992, 0.8548055731845162, 1.0628454932761202), rotation: new Euler(-0.7079403135831094, 0.9088139060848945, 0.5938561528919046) },
        { name: "Very far away", position: new Vector3(13.336517975968864, 2.399780986066818, 3.0129436502811733), rotation: new Euler(-0.6725973350194719, 1.2896276568959506, 0.653167025497404) },
        { name: "Multi-cube", position: new Vector3(5.72725123221618, 0, 0), rotation: new Euler(0.9273842476318528, 0.5 * Math.PI, -0.9269676945976868) },
        { name: "Single Face (Front)", position: new Vector3(1, 0, 0), rotation: new Euler(0, Math.PI / 2, 0) },
        { name: "Single Face (Back)", position: new Vector3(-1, 0, 0), rotation: new Euler(Math.PI, -Math.PI / 2, Math.PI) },
        { name: "Single Face (Top)", position: new Vector3(1e-5, 1, 0), rotation: new Euler(-Math.PI / 2, 1e-8, Math.PI / 2) },
        { name: "Single Face (Bottom)", position: new Vector3(1e-5, -1, 0), rotation: new Euler(Math.PI / 2, 0, -Math.PI / 2) },
        { name: "Single Face (Left)", position: new Vector3(0, 0, 1), rotation: new Euler(0, 0, 0) },
        { name: "Single Face (Right)", position: new Vector3(0, 0, -1), rotation: new Euler(Math.PI, 0, Math.PI) },
    ];

    private htmlQualitySelect!: HTMLSelectElement;
    private htmlCubeSelect!: HTMLSelectElement;
    private htmlParameterSelect!: HTMLSelectElement;

    private statusMessageDiv!: HTMLElement;
    private hoverInfoDiv!: HTMLElement;
    private datasetInfoDialogDiv!: HTMLElement;
    private datasetInfoDialogWrapperDiv!: HTMLElement;
    private datasetInfoCornerListDiv!: HTMLElement;

    private volumeVizRenderStyleSelect!: HTMLSelectElement;

    private htmlVolumeVizMainColumn!: HTMLElement;
    private htmlVolumeVizLoaderColumn!: HTMLElement;

    private htmlFullscreenButton!: HTMLElement;
    private htmlDataSelectButton!: HTMLElement;
    private htmlDataSelectUi!: HTMLElement;
    private htmlDownloadImageButton!: HTMLElement;
    private htmlDownloadPrintTemplateButton!: HTMLElement;

    // UI managers
    private colormapUi!: ColormapUIManager;
    private sliderUi!: SliderUIManager;
    private animationUi!: AnimationUIManager;

    private htmlPrintTemplateResultWrapper!: HTMLElement;
    private htmlPrintTemplateResult!: HTMLElement;
    private htmlPrintTemplateDownloadButtonPng!: HTMLAreaElement;
    private htmlPrintTemplateDownloadButtonSvg!: HTMLAreaElement;
    private htmlPrintTemplateDownloadEditNoteButton!: HTMLAreaElement;

    private htmlPrintTemplateLoadingSection!: HTMLElement;
    private htmlPrintTemplateLoaderVideo!: HTMLVideoElement;
    private htmlPrintTemplateResultSection!: HTMLElement;

    private htmlGpsButton!: HTMLElement

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

    private htmlDisableVolumeVizButton!: HTMLElement;
    private htmlEnableVolumeVizButton!: HTMLElement;
    private htmlVolumeVizSection!: HTMLElement;
    private htmlVolumeVizStatsRow!: HTMLElement;
    private htmlVolumeVizDescriptionRow!: HTMLElement;
    private htmlVolumeVizThresholdTarget!: HTMLElement;
    private htmlVolumeVizThresholdType!: HTMLElement;
    private htmlVolumeVizThresholdSpatialQuantileContext!: HTMLElement;

    private htmlDownloadDatasetSubsetButton!: HTMLElement;
    private downloadSubsetInProgress: boolean = false;

    private htmlParent: HTMLElement;

    updateWidgetModelRanges: () => void = () => { };
    updateWidgetCameraAngle: () => void = () => { };

    private htmlTimeSeriesDiv!: HTMLElement;
    private htmlTimeSeriesCanvas!: HTMLCanvasElement;
    private htmlTimeSeriesCloseButton!: HTMLElement;

    private htmlVolumeVizEventTableBody!: HTMLElement;
    private htmlVolumeVizEventExploreLink!: HTMLElement;

    private resolutionChangePopupDiv!: HTMLElement;
    private resolutionChangeLabelDiv!: HTMLElement;
    private resolutionChangeHeadingDiv!: HTMLElement;

    private recordAnimation: boolean = false;
    private nextAnimationStepScheduled: boolean = false;
    private animationRecordingSupported: boolean = false;

    private requestProgressTimingEnabled: boolean = false;
    private requestProgressStart: number = 0;
    private requestProgressLastUpdate: number = 0;
    
    orchestratorAnimationRunning: boolean = false;

    private timeSeriesChart!: Chart<"line", number[], string>;
    private timeSeries: TimeSeries[] = [];

    private hoveringOverContextLayer = false;
    private lastContextLayerInteraction = 0;
    private readonly CONTEXT_LAYER_INTERACTION_COOLDOWN_MS = 50;

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

        // this.volumeVizRenderStyleSelect = this.getHtmlElementByClassName('volume-viz-render-style-select')! as HTMLSelectElement;

        this.htmlFullscreenButton = this.getHtmlElementByClassName('fullscreen-button')!;
        this.htmlDataSelectButton = this.getHtmlElementByClassName('data-select-button')!;
        this.htmlDataSelectUi = this.getHtmlElementByClassName('options-ui')!;
        this.htmlDownloadImageButton = this.getHtmlElementByClassName('download-image-button')!;
        this.htmlDownloadDatasetSubsetButton = this.getHtmlElementByClassName('download-dataset-subset-button')!;
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

        this.htmlEnableVolumeVizButton = this.getHtmlElementByClassName('enable-volume-viz-button')!;
        this.htmlDisableVolumeVizButton = this.getHtmlElementByClassName('disable-volume-viz-button')!;
        this.htmlVolumeVizSection = this.getHtmlElementByClassName('volume-viz-section')!;
        this.htmlVolumeVizStatsRow = this.getHtmlElementByClassName('volume-viz-stats-row')!;
        this.htmlVolumeVizDescriptionRow = this.getHtmlElementByClassName('volume-viz-description-row')!;
        this.htmlVolumeVizThresholdTarget = this.getHtmlElementByClassName('volume-viz-threshold-target')!;
        this.htmlVolumeVizThresholdType = this.getHtmlElementByClassName('volume-viz-threshold-type')!;
        this.htmlVolumeVizThresholdSpatialQuantileContext = this.getHtmlElementByClassName('volume-viz-threshold-spatial-quantile-context')!;
        this.htmlVolumeVizMainColumn = this.getHtmlElementByClassName('volume-viz-main-column')!;
        this.htmlVolumeVizLoaderColumn = this.getHtmlElementByClassName('volume-viz-loader-column')!;

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

        this.resolutionChangePopupDiv = this.getHtmlElementByClassName("resolution-change-popup")!;
        this.resolutionChangeLabelDiv = this.getHtmlElementByClassName("resolution-change-label")!;
        this.resolutionChangeHeadingDiv = this.getHtmlElementByClassName("resolution-change-heading")!;

        this.htmlTimeSeriesDiv = this.getHtmlElementByClassName("time-series-ui")!;
        this.htmlTimeSeriesCloseButton = this.getHtmlElementByClassName("time-series-close-button")!;
        this.htmlTimeSeriesCanvas = this.getHtmlElementByClassName("time-series-canvas")! as HTMLCanvasElement;

        this.htmlVolumeVizEventTableBody = this.getHtmlElementByClassName("volume-viz-event-table-body")!;
        this.htmlVolumeVizEventExploreLink = this.getHtmlElementByClassName("volume-viz-event-explore-link")! as HTMLAnchorElement;

        // Delegate to UI managers
        this.colormapUi.setupHtmlReferences(this.htmlParent);
        this.sliderUi.setupHtmlReferences();
        this.animationUi.setupHtmlReferences(this.htmlParent);
    }

    fullyLoaded = false;

    private availableCubes: LogicalDataCube[] = [];
    selectedCube!: LogicalDataCube;
    selectedParameterId!: string;

    cubeDimensions!: CubeDimensions;
    cubeSelection!: CubeSelection;
    private cubeParameters!: Map<string, Parameter>;
    private selectedParameter!: Parameter;
    private selectedCubeMetadata!: { attrs: any, coords: any, data_vars: any, dims: any, max_lod_2d: number, max_lod_3d: number, enable_2d_tiles: boolean, enable_3d_tiles: boolean, sparsity: number, allow_data_downloads: boolean };

    private interactingFace = -1;
    private panStartUv = new Vector2();
    private panStartDisplayOffset = new Vector2();

    private hoverData: PickedDataValue = new PickedDataValue();

    private isMouseHoveringOverCube: boolean = false;
    private lastHoverMousePosition: Vector2 | undefined = undefined;

    private lastIndexValue: Array<number> = new Array<number>(6);
    private floatDisplaySignificance = 2;
    fullscreenActive: boolean = false;

    private orbitControls!: CameraControls;
    private currentZoomFactor: number[] = [1.0, 1.0, 1.0];
    private previousZoomFactor: number[] = [1.0, 1.0, 1.0];

    private currentZoomNewCenterPoint: Vector2 | undefined;
    private currentZoomOldCenterPoint: Vector2 | undefined;

    private currentTouchEventOnCube = true;
    private currentMouseEventOnCube = true;
    private currentMouseEventActive = false;
    private currentTouchEventActive = false;

    private panMoveCalled = 0;

    private currentZoomFace: number = -1;

    private interactionFinishDisplaySize: Vector2 | undefined;
    private interactionFinishDisplayOffset: Vector2 | undefined;
    private interactionFinishFace: CubeFace | undefined;
    private interactionWasSimpleClick: boolean = false;

    private deferredVisibilityAndLodUpdateMilliseconds = 150;
    private deferredVisibilityAndLodUpdateTimeoutHandler: number = 0;
    XYdataAspectRatio: number = 1; // longitude divided by latitude

    geospatialContextProvided: boolean = false;

    get selectedColormapName(): string { return this.colormapUi.selectedColormapName; }
    set selectedColormapName(v: string) { this.colormapUi.selectedColormapName = v; }
    get selectedColormapCategory(): string { return this.colormapUi.selectedColormapCategory; }
    set selectedColormapCategory(v: string) { this.colormapUi.selectedColormapCategory = v; }

    private animationParameters!: AnimationParameters;

    private animationLastFrameTime = 0;
    private animationLastStepTime = 0;

    private animationEnabled = false;
    private animationFinishRequested = false;

    private renderedAfterAllTilesDownloaded: boolean = false;

    cubeTags: CubeTag[] = [];

    initialLoad = true;
    private updateLabelPositionTimeoutId: number = 0;

    private additionalStatusMessageTimer: number = 0;
    private additionalStatusMessage: string = "";

    private connectionLostMessageVisible: boolean = false;

    private localStorageUpdateWarningKey = "lexcube_jupyter_last_update_notification";
    private packageUpdateReminderInterval = 1000 * 60 * 60; // 1 hour

    private readonly availableExtremeTypes = [
        new ExtremeType(1, "AO",  ExtremeThresholdTarget.Observations,      ExtremeThresholdType.Absolute, null),
        new ExtremeType(2, "AD",  ExtremeThresholdTarget.DeviationsFromMSC, ExtremeThresholdType.Absolute, null),
        new ExtremeType(3, "QGO", ExtremeThresholdTarget.Observations,      ExtremeThresholdType.Quantile, ExtremeSpatialQuantileContext.AllTimeSeries),
        new ExtremeType(4, "QGD", ExtremeThresholdTarget.DeviationsFromMSC, ExtremeThresholdType.Quantile, ExtremeSpatialQuantileContext.AllTimeSeries),
        new ExtremeType(5, "QRO", ExtremeThresholdTarget.Observations,      ExtremeThresholdType.Quantile, ExtremeSpatialQuantileContext.PcaGroupedTimeSeries),
        new ExtremeType(6, "QRD", ExtremeThresholdTarget.DeviationsFromMSC, ExtremeThresholdType.Quantile, ExtremeSpatialQuantileContext.PcaGroupedTimeSeries),
        new ExtremeType(7, "QLO", ExtremeThresholdTarget.Observations,      ExtremeThresholdType.Quantile, ExtremeSpatialQuantileContext.SingleTimeSeries),
        new ExtremeType(8, "QLD", ExtremeThresholdTarget.DeviationsFromMSC, ExtremeThresholdType.Quantile, ExtremeSpatialQuantileContext.SingleTimeSeries),
    ];

    private currentExtremeType: ExtremeType = this.availableExtremeTypes[0];


    constructor(context: CubeClientContext, htmlParent: HTMLElement) {
        this.context = context;
        this.htmlParent = htmlParent;

        const self = this;

        // Create colormap UI manager
        const colormapHost: ColormapUIHostState = {
            get widgetMode() { return context.widgetMode; },
            get expertMode() { return context.expertMode; },
            get isClientPortrait() { return context.isClientPortrait(); },
            get tileData() { return context.tileData; },
            get selectedParameter() { return self.selectedParameter; },
            get floatDisplaySignificance() { return self.floatDisplaySignificance; },
            log: (...args: any[]) => context.log(...args),
            toFixed: (f: number) => self.toFixed(f),
            onWidgetColormapChanged: (name: string) => self.updateWidgetColormap(name),
            onWidgetColormapRangeChanged: (min: number | null, max: number | null) => self.updateWidgetModelColormapRange(min, max),
        };
        this.colormapUi = new ColormapUIManager(colormapHost);

        // Create slider UI manager
        const sliderHost: SliderUIHostState = {
            get updateUiDuringInteractionsSliders() { return self.updateUiDuringInteractions.sliders; },
            get cubeDimensions() { return self.cubeDimensions; },
            get cubeSelection() { return self.cubeSelection; },
            get sparsity() { return self.selectedCubeMetadata.sparsity; },
            get geospatialContextProvided() { return self.geospatialContextProvided; },
            get cubeTags() { return self.cubeTags; },
            get animationParameters() { return self.animationParameters; },
            log: (...args: any[]) => context.log(...args),
            onSelectionRangeChanged: (dim, min, max) => { self.cubeSelection.setRange(dim, min, max); },
            onSelectionUiUpdate: (downloadTiles, force) => { self.cubeSelection.updateSelectionRelevantUi(downloadTiles, force); },
            onVisibilityAndLodUpdate: () => { context.rendering.updateVisibilityAndLods(); },
            onVolumeAbsoluteThresholdChanged: (v, updateUi) => { self.setVolumeRenderingAbsoluteThreshold(v, updateUi); },
            onVolumeQuantileThresholdChanged: (v, updateUi) => { self.setVolumeRenderingQuantileThreshold(v, updateUi); },
            onVolumeRangeChanged: (min, max, updateUi) => { self.setVolumeRenderingRange(min, max, updateUi); },
            onVolumeUseQuantileChanged: (useQuantile) => { self.setVolumeRenderingUseQuantileOverAbsoluteThreshold(useQuantile); },
            getVolumeRenderingThresholdSign() { return self.getVolumeRenderingThresholdSign(); },
            setVolumeRenderingThresholdSign(sign, updateUi) { self.setVolumeRenderingThresholdSign(sign, updateUi); },
            toFixed: (f: number) => self.toFixed(f),
            getUnitHTML: () => self.selectedParameter ? self.selectedParameter.getUnitHTML() : "",
        };
        this.sliderUi = new SliderUIManager(sliderHost, htmlParent);

        // Create animation UI manager
        const animationHost: AnimationUIHostState = {
            get animationParameters() { return self.animationParameters; },
            get cubeDimensions() { return self.cubeDimensions; },
            get cubeSelection() { return self.cubeSelection; },
            get animationRecordingSupported() { return self.animationRecordingSupported; },
            get recordAnimation() { return self.recordAnimation; },
            set recordAnimation(v) { self.recordAnimation = v; },
            log: (...args: any[]) => context.log(...args),
            onStartAnimation: () => self.startAnimation(),
            onStopAnimation: () => self.stopAnimation(),
            onStartRecording: (fps) => context.rendering.startRecordingAnimation(fps),
            onStopRecording: () => context.rendering.stopRecordingAnimation(),
            onAnimationDimensionChanged: (dim) => self.updateAnimationDimension(dim),
            onAnimationSelectedRangeOnlyChanged: () => self.setAnimationUseSelectedRangeOnly(),
            onRecordingFormatChanged: (format) => context.rendering.setAnimationRecordingFormat(format),
            showAnimationSettingsHover: (hideIfAlreadyShown: boolean = false) => self.showAnimationSettingsHover(hideIfAlreadyShown),
            get isTouchDevice() { return context.touchDevice; },
        };
        this.animationUi = new AnimationUIManager(animationHost);

        if (context.expertMode) {
            document.querySelector('style')!.innerHTML = ".expert-mode { display: block; }";
        }
        if (context.orchestrationMasterMode) {
            document.querySelector('style')!.innerHTML += ".lexcube-body .toolbar-ui-button { width: 84px; height: 84px; }";
        }
    }

    async startup() {
        this.setupHtmlInterface();
        this.prepareTimeSeriesChart();
        this.sliderUi.prepareAll();
        this.colormapUi.initializeScale();
        this.colormapUi.initializeUi();
        this.registerEvents();
        this.applyCameraPreset();
        await this.retrieveMetaData();
        this.parseUrlFragment();
        await this.selectInitialCube();
        this.disableAllLinksInOrchestrationMasterMode();
        if (this.context.orchestrationMasterMode || this.context.orchestrationMinionMode) {
            window.setInterval( () => {
                this.context.networking.resetTileCache(); // reset tile cache every hour in long-running orchestration settings
            }, 1000 * 60 * 60);
        }
    }

    private disableAllLinksInOrchestrationMasterMode() {
        if (!this.context.orchestrationMasterMode) {
            return;
        }

        window.setTimeout(() => {
            var anchors = document.getElementsByTagName("a");
            for (var i = 0; i < anchors.length; i++) {
                anchors[i].href = "";
                anchors[i].target = "";
                anchors[i].onclick = (ev: MouseEvent) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    return false;
                };
            }
        }, 1);
    }

    async selectInitialCube() {
        if (this.initialSelectionState.cubeId) {
            if (await this.findToSelectCube(this.initialSelectionState.cubeId)) {
                return;
            }
        }
        const hermes = this.availableCubes.find(cube => cube.id.startsWith("hermes-"));
        const esdc3 = this.availableCubes.find(cube => cube.id.startsWith("esdc-3.0.2"));
        for (let priorityCubes of [hermes, esdc3]) {
            if (priorityCubes) {
                if (await this.findToSelectCube(priorityCubes.id)) {
                    return;
                }
            }
        }
        await this.findToSelectCube(this.availableCubes[0].id);
    }

    private interactWithContextLayer(pickedObject: Object3D | null, eventType: ContextLayerInteraction = ContextLayerInteraction.Click) {
        if (eventType == ContextLayerInteraction.HoverLeave) {
            this.unhighlightTimeSeries();
            this.hoveringOverContextLayer = false;
        }
        if (!this.checkContextLayerInteractionCooldown()) {
            return;
        }
        if (!pickedObject) {
            return;
        }
        while (!pickedObject.userData || !pickedObject.userData["isContextLayerObject"]) {
            pickedObject = pickedObject.parent as Object3D;
            if (!pickedObject) {
                return;
            }
        }
        if (pickedObject.userData && pickedObject.userData["isTimeSeriesMarker"]) {
            const id = pickedObject.userData["timeSeriesId"];
            this.context.log(`Interacted with time series marker id=${id}, eventType=${ContextLayerInteraction[eventType]}`);
            if (eventType == ContextLayerInteraction.Click) {
                this.removeTimeSeries(id);
            } else if (eventType == ContextLayerInteraction.HoverEnter) {
                this.highlightTimeSeries(id);
                this.hoveringOverContextLayer = true;
            }
        }
    }
    
    private mouseDisabledHtmlElements: HTMLElement[] = [];

    private enableMouseOnAllUiElements() {
        for (const el of this.mouseDisabledHtmlElements) {
            el.style.pointerEvents = (el as any)._originalPointerEvents || "";
        }
        this.mouseDisabledHtmlElements = [];
    }

    private disableMouseOnAllUiElements() {
        this.enableMouseOnAllUiElements();

        const candidates = this.htmlParent.querySelectorAll<HTMLElement>("*");
        
        for (const el of candidates) {
            if ((el.style.pointerEvents || el.classList.contains("ui-normal") || el.classList.contains("toolbar-ui")) && !el.hasAttribute("data-engine")) {
                this.mouseDisabledHtmlElements.push(el);
                if (!(el as any)._originalPointerEvents && el.style.pointerEvents != "none") {
                    (el as any)._originalPointerEvents = el.style.pointerEvents;
                }
                el.style.pointerEvents = "none";
            }
        }
    }

    updateToolbarPosition() {
        const toolbarUi = this.getHtmlElementByClassName("toolbar-ui");
        if (this.context.isClientPortrait()) {
            toolbarUi.style.maxWidth = "100%";
            toolbarUi.style.width = "100%";
            toolbarUi.style.top = "8.5%";
            toolbarUi.style.right = "0%";
            toolbarUi.style.justifyContent = "center";
        } else {            
            toolbarUi.style.maxWidth = "";
            toolbarUi.style.width = "";
            toolbarUi.style.top = "1.5%";
            toolbarUi.style.right = "1.5%";
            toolbarUi.style.justifyContent = "";
        }
    }

    private registerEvents() {
        const domElement = this.context.rendering.getDomElement();
        this.orbitControls = new CameraControls(this.context, this.context.rendering.getCurrentCamera(), domElement);
        if (this.context.orchestrationMinionMode || this.context.orchestrationMasterMode) {
            this.orbitControls.enablePan = false;
        }
        this.orbitControls.addEventListener("change", () => {;
            if (this.updateUiDuringInteractions.orbitControls) {
                this.context.rendering.updateVisibilityAndLods();
            } else {
                this.context.rendering.updateVisibilityAndLods(false);
            }
            if (this.context.lowPerformanceDeviceMode) {
                debounce(50, this.updateLabelPositions.bind(this))();
            } else {
                this.updateLabelPositions();
            }
        });
        this.orbitControls.addEventListener("end", () => { this.context.rendering.updateVisibilityAndLods(); });
        this.orbitControls.addEventListener("end", () => { this.requestUrlFragmentUpdate(); });
        this.orbitControls.addEventListener("end", () => {
            window.setTimeout(() => {
                this.updateLabelPositions(); // delay for camera matrix to catch up
            }, 25);
            this.updateWidgetCameraAngle();
        });
        
        const isOverCube = (position: Vector2) => {
            return this.context.rendering.isWindowPositionOverCube(position); // faster call instead of raycast, but needs swapping out once we have more complex scene than just one unit cube.
            // return this.context.rendering.raycastWindowPosition(position.x, position.y).type == RaycastResultType.Cube;
        }

        const getRaycastTarget = (position: Vector2, contextLayerAllowed: boolean) => {
            return this.context.rendering.raycastWindowPosition(position.x, position.y, contextLayerAllowed);
        }

        domElement.addEventListener('wheel', (ev: WheelEvent) => {
            if (!this.fullyLoaded) {
                return;
            }
            ev.preventDefault();
            ev.stopPropagation();
            if (isOverCube(this.getLocalEventPosition(ev))) {
                this.onZoom([ev], -ev.deltaY, true);
            } else {
                this.orbitControls.onMouseWheel(ev);
            }
            if (!this.currentMouseEventActive) {
                // if panning and zooming at same time: do not refresh as selection may not be rounded to sparsity
                this.triggerDeferredVisibilityAndLodUpdate();
            }

            this.context.rendering.requestRender();
        }, false);
        domElement.addEventListener('mousedown', (ev: any) => {
            if (!this.fullyLoaded) {
                return;
            }
            const localEventPosition = this.getLocalEventPosition(ev);
            const raycastTarget = getRaycastTarget(localEventPosition, true);
            if (raycastTarget.type == RaycastResultType.ContextLayer) {
                this.interactWithContextLayer(raycastTarget.ray[0].object, ContextLayerInteraction.Click);
                return;
            }
            this.interactionWasSimpleClick = true;
            this.hideMenusForTouchDevices();
            this.currentMouseEventActive = true;
            this.currentMouseEventOnCube = raycastTarget.type == RaycastResultType.Cube;
            (ev as any).actOnWorld = !this.currentMouseEventOnCube;
            if (!this.currentMouseEventOnCube) {
                this.orbitControls.onMouseDown(ev);
                this.disableMouseOnAllUiElements();
            } else {
                this.onPanStart(localEventPosition);
            }
            this.context.rendering.requestRender(this.currentMouseEventOnCube);
        }, false);
        domElement.addEventListener( 'mousemove', (ev: any) => {
            if (!this.fullyLoaded) { 
                return; 
            }
            const localEventPosition = this.getLocalEventPosition(ev);
            const raycastTarget = getRaycastTarget(localEventPosition, true);
            if (this.hoveringOverContextLayer && raycastTarget.type != RaycastResultType.ContextLayer) {
                this.interactWithContextLayer(null, ContextLayerInteraction.HoverLeave);
                return;
            }
            if (raycastTarget.type == RaycastResultType.ContextLayer && !this.currentMouseEventActive) {
                if (!this.hoveringOverContextLayer) {
                    this.interactWithContextLayer(raycastTarget.ray[0].object, ContextLayerInteraction.HoverEnter);
                }
                return;
            }
            const overCube = raycastTarget.type == RaycastResultType.Cube;
            domElement.style.cursor = overCube ? "all-scroll" : "default";
            if (!this.currentMouseEventActive) {
                if (overCube) {
                    this.isMouseHoveringOverCube = true;
                    this.updateHoverInfo(localEventPosition);
                } else {
                    this.isMouseHoveringOverCube = false;
                    this.lastHoverMousePosition = undefined;
                    this.changeHoverInfoUiVisibility(false);
                    this.context.rendering.hidePick3d();
                }
                return;
            }
            (ev as any).actOnWorld = !this.currentMouseEventOnCube;
            if (!this.currentMouseEventOnCube) {
                this.orbitControls.onMouseMove(ev);
            } else {
                this.onPanMove(localEventPosition);
            }
            this.context.rendering.requestRender(this.currentMouseEventOnCube);
        }, false);
        domElement.addEventListener('mouseup', (ev: any) => {
            if (!this.fullyLoaded) {
                return;
            }
            if (!this.currentMouseEventActive) {
                return;
            }
            this.currentMouseEventActive = false;
            (ev as any).actOnWorld = !this.currentMouseEventOnCube;
            if (!this.currentMouseEventOnCube) {
                this.orbitControls.onMouseUp(ev);
                this.enableMouseOnAllUiElements();
            } else {
                this.finishInteraction();
            }
            this.context.rendering.requestRender(this.currentMouseEventOnCube);
        }, false);

        domElement.addEventListener('touchstart', (ev: TouchEvent) => {
            if (!this.fullyLoaded) {
                return;
            }
            // if (this.context.orchestrationMinionMode && ev.touches.length > 2) {
            //     (ev as any).touches = [ev.touches[0]];
            // }
            if (ev.touches.length == 1) {
                const raycastTarget = getRaycastTarget(this.getLocalEventPosition(ev.touches[0]), true);
                if (raycastTarget.type == RaycastResultType.ContextLayer) {
                    this.interactWithContextLayer(raycastTarget.ray[0].object, ContextLayerInteraction.Click);
                    return;
                }
            }
            if (ev.touches.length == 1) {
                this.interactionWasSimpleClick = true;
            }
            this.currentTouchEventActive = true;
            this.hideMenusForTouchDevices();
            this.currentTouchEventOnCube = Array.from(ev.touches).every((value: Touch, index: number, array: Touch[]) => { return isOverCube(this.getLocalEventPosition(value)) });
            (ev as any).actOnWorld = !this.currentTouchEventOnCube;
            this.orbitControls.onTouchStart(ev);
            this.context.rendering.requestRender(this.currentTouchEventOnCube);
        }, false);
        domElement.addEventListener('touchend', (ev: TouchEvent) => {
            if (!this.fullyLoaded || !this.currentTouchEventActive) {
                return;
            }
            // if (this.context.orchestrationMinionMode && ev.touches.length > 2) {
            //     (ev as any).touches = [ev.touches[0]];
            // }
            (ev as any).actOnWorld = !this.currentTouchEventOnCube;
            this.finishInteraction();
            if (!this.currentTouchEventOnCube) {
                this.orbitControls.onTouchEnd(ev);
            }
            this.context.rendering.requestRender(this.currentTouchEventOnCube);
        }, false);
        domElement.addEventListener('touchmove', (ev: TouchEvent) => {
            if (!this.fullyLoaded || !this.currentTouchEventActive) {
                return;
            }
            if (ev.touches.length != 1) {
                this.interactionWasSimpleClick = false;
            }
            // if (this.context.orchestrationMinionMode && ev.touches.length > 2) {
            //     (ev as any).touches = [ev.touches[0]];
            // }
            (ev as any).actOnWorld = !this.currentTouchEventOnCube;
            this.orbitControls.onTouchMove(ev);
            this.context.rendering.requestRender(this.currentTouchEventOnCube);
            this.isMouseHoveringOverCube = false;
            this.changeHoverInfoUiVisibility(false);
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
        const angleToTranslate = (v: number) => `translate(-${clamp(200 * (0.75 - Math.abs(1 - v)), 0, 100)}%, -${clamp(200 * (0.75 - Math.abs(1 - ((v + 1.5) % 2))), 0, 100)}%)`;

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
        if (this.interactionFinishDisplayOffset) {
            // this.cubeSelection.fixAllVectorsToSparsity();
            this.cubeSelection.setVectors(this.interactionFinishFace!, this.interactionFinishDisplaySize || new Vector2(), this.interactionFinishDisplayOffset);
        }
        if (this.interactionWasSimpleClick && this.interactingFace == CubeFace.Front) {
            this.createOrDeleteTimeSeries(this.interactingFace, this.panStartUv);
        }
        this.interactionFinishFace = undefined;
        this.interactionFinishDisplaySize = undefined;
        this.interactionFinishDisplayOffset = undefined;
        this.interactingFace = -1;
        this.interactionWasSimpleClick = false;
        this.previousZoomFactor[Math.floor(this.currentZoomFace / 2)] = this.currentZoomFactor[Math.floor(this.currentZoomFace / 2)];
        this.currentZoomFace = -1;
        this.currentZoomNewCenterPoint = undefined;
        this.currentZoomOldCenterPoint = undefined;
        this.context.rendering.updateVisibilityAndLods();
    }

    onPanStart(initialPosition: Vector2) {
        this.panMoveCalled = 0;
        const raycastResult = this.context.rendering.raycastWindowPosition(initialPosition.x, initialPosition.y);
        const ray = raycastResult.ray;
        const targetFace = ray[0].face!.materialIndex;
        if (targetFace < 0 || targetFace >= 6) {
            return console.error("Bad material face index for interaction")
        }
        if (this.context.singleFaceMode && targetFace != this.context.singleFace) {
            return console.warn("Interaction on face", CubeFace[targetFace], "not allowed in single face mode");
        }
        this.interactingFace = targetFace;
        this.context.log("Panning:", CubeFace[this.interactingFace].toUpperCase())

        this.panStartUv.set(ray[0].uv!.x, ray[0].uv!.y);
        this.panStartDisplayOffset.copy(this.cubeSelection.getDisplayOffsetVector2d(this.interactingFace));
    }

    private normalizeOverflowingXValue(x: number, face: CubeFace) {
        const width = this.cubeDimensions.totalWidthForFace(face);
        const displaySize = this.cubeSelection.getDisplaySizeVector2d(face);
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

    private getXOverflowEnabledForFace(face: CubeFace) { // in case of X, local X and data X are the same
        return (face != CubeFace.Left && face != CubeFace.Right) && this.context.rendering.dimensionOverflow[Dimension.X];
    }

    onPanMove(currentPosition: Vector2) {
        this.panMoveCalled += 1;
        const raycastResult = this.context.rendering.raycastWindowPosition(currentPosition.x, currentPosition.y);
        const ray = raycastResult.ray;
        if (!ray || ray.length == 0) {
            // console.warn("Ray intersection is zero length");
            return;
        }
        const targetFace = ray[0].face!.materialIndex;
        if (targetFace != this.interactingFace) {
            return;
        }
        if (this.context.singleFaceMode && targetFace != this.context.singleFace) {
            return console.warn("Interaction on face", CubeFace[targetFace], "not allowed in single face mode");
        }
        const xOverflowEnabled = this.getXOverflowEnabledForFace(targetFace);
        const displaySize = this.cubeSelection.getDisplaySizeVector2d(this.interactingFace).clone();
        const uvDifference = new Vector2(ray[0].uv!.x - this.panStartUv.x, (ray[0].uv!.y - this.panStartUv.y));
        const newDisplayOffset = uvDifference.multiply(displaySize).sub(this.panStartDisplayOffset).multiplyScalar(-1);
        const minimumDisplayOffset = this.getMinimumDisplayOffset(targetFace);
        const maximumDisplayOffset = this.getMaximumDisplayOffset(targetFace, displaySize);
        const unclampedNewDisplayOffset = newDisplayOffset.clone();
        if (xOverflowEnabled) {
            newDisplayOffset.y = clamp(newDisplayOffset.y, minimumDisplayOffset.y, maximumDisplayOffset.y);
            newDisplayOffset.x = this.normalizeOverflowingXValue(newDisplayOffset.x, targetFace);
        } else {
            newDisplayOffset.clamp(minimumDisplayOffset, maximumDisplayOffset);
        }
        this.cubeSelection.setOffsetVectorNoRounding(this.interactingFace, newDisplayOffset);
        this.interactionFinishFace = targetFace;
        this.interactionFinishDisplayOffset = newDisplayOffset;
        const anyIndicatorTriggered = this.triggerMaxRangeIndicatorsFromOffsetIfScrolledOutSignificantly(targetFace, unclampedNewDisplayOffset, displaySize);
        this.interactionWasSimpleClick = this.interactionWasSimpleClick && this.cubeSelection.getDisplayOffsetVector2d(this.interactingFace).distanceTo(this.panStartDisplayOffset) < 2 && !anyIndicatorTriggered;
        if (this.panMoveCalled % 10 == 0) {
            this.triggerTileDownloads2d(targetFace);
        }
    }

    onZoom(eventPositions: (MouseEvent | Touch)[], zoomDelta: number, immediate: boolean = false) {
        let ray: Intersection<Object3D>[];
        for (let i = 0; i < eventPositions.length; i++) {
            // position = eventPositions[i];             
            const localEventPosition = this.getLocalEventPosition(eventPositions[i]);
            ray = this.context.rendering.raycastWindowPosition(localEventPosition.x, localEventPosition.y).ray;
            if (ray && ray[0]) {
                break;
            }
        }
        const r = ray!;
        if (!immediate && this.currentZoomFace == -1) {
            this.currentZoomFace = r[0]!.face!.materialIndex;
        }
        if (!r[0]) {
            return console.warn("No ray intersection during zoom event");
        }
        if (!r[0].uv || !r[0].face) {
            return console.warn("No UV or face information in ray intersection during zoom event");
        }
        let uv = r[0].uv ? r[0].uv : new Vector2(0.5, 0.5);
        // if (eventPositions.length == 2) {
        //     const middle = this.getLocalEventPosition(eventPositions[0]).add(this.getLocalEventPosition(eventPositions[1])).multiplyScalar(0.5);
        //     const middleRay = this.context.rendering.raycastWindowPosition(middle.x, middle.y);
        //     if (middleRay && middleRay[0].face?.materialIndex == this.currentZoomFace) {
        //         uv = middleRay[0].uv!;
        //     }
        // } else if (eventPositions.length == 1) {
        //     uv = r[0].uv!;
        // } else {
        //     console.warn("No behavior for zooming with 3 or more positions")
        // }
        if (Math.abs(zoomDelta) > 0.001) {
            this.changeZoomOnFace(Math.sign(zoomDelta) * clamp(Math.abs(zoomDelta), 0.001, 20.0) * 3, immediate ? r[0].face!.materialIndex : this.currentZoomFace, uv, immediate);
            return true;
        }
        return false;
    }

    updateWidgetModelColormapRange: (minValue: number | null, maxValue: number | null) => void = () => {};
    updateWidgetColormap: (name: string) => void = () => {};

    private updateColormapOverrideRangesFromUi(updateColormap: boolean = true) {
        this.colormapUi.updateOverrideRangesFromUi(updateColormap);
    }

    private updateHoverInfo(mousePosition: Vector2 | undefined = undefined) {
        if (!mousePosition) {
            if (!this.lastHoverMousePosition) {
                throw new Error("No mouse position to update hover info");
            }
            mousePosition = this.lastHoverMousePosition;
        }
        const raycastResult = this.context.rendering.raycastWindowPosition(mousePosition.x, mousePosition.y);
        const r = raycastResult.ray;
        if (!r || r.length == 0) {
            return;
        }
        if (this.context.rendering.volumeRenderingEnabled) {
            // 3d picking
            this.context.rendering.requestPick3d(mousePosition.x, mousePosition.y);
        } else {
            // 2d picking
            const face = r[0].face!.materialIndex;
            const uv = r[0].uv!;
            this.hoverData.setFrom2dTileData(this.cubeSelection, this.cubeDimensions, this.context.rendering, this.context.tileData, this.selectedCube.id, this.selectedParameterId, face, uv);
            this.updateHoverInfoUi();
        }
        this.lastHoverMousePosition = mousePosition;
    }

    receivePick3d(pickedVoxelIndex: Vector3, hit: boolean, featureId: number) {
        if (!hit) {
            this.changeHoverInfoUiVisibility(false);
            return;
        }
        // todo: do something with featureID and the properties 

        this.hoverData.setFrom3dTileData(pickedVoxelIndex, this.context.rendering.lod3d, this.cubeDimensions, this.context.tileData, this.selectedCube.id, this.selectedParameterId);
        this.updateHoverInfoUi();
    }

    private updateHoverInfoUi(show: boolean = true) {
        this.changeHoverInfoUiVisibility(show);
        let lines = [];

        // if (this.hoverData.isDataValueNotLoaded) {
        //     lines.push(`Value: Data not yet loaded`)
        // } else if (typeof this.hoverData.dataValue === "number") {
        //     if (isNaN(this.hoverData.dataValue) || this.hoverData.isDataNan) {
        //         lines.push(`Value: No Data`);
        //     } else {
        //         const value = `${this.toFixed(this.selectedParameter.getConvertedDataValue(this.hoverData.dataValue))}`;
        //         lines.push(`Value: ${value} ${this.selectedParameter.getUnitHTML()}`);
        //     }
        // } else if (this.hoverData.dataValue instanceof Uint8Array) {
        //     const c = this.selectedParameter.getRgbDataValueString(this.hoverData.dataValue, this.hoverData.isDataNan);
        //     for (const color of c) {
        //         lines.push(color);
        //     }
        // }
        const valueLines = this.hoverData.getString(this, this.selectedParameter, "Value: ");
        lines.push(valueLines);
        
        lines.push(`${this.cubeDimensions.z.getName()}: ${this.cubeDimensions.z.getIndexString(this.hoverData.z)}${this.context.debugMode ? ` (Z / ${this.hoverData.z})` : ""}`);
        lines.push(`${this.cubeDimensions.y.getName()}: ${this.cubeDimensions.y.getIndexString(this.hoverData.y)}${this.context.debugMode ? ` (Y / ${this.hoverData.y})` : ""}`);
        lines.push(`${this.cubeDimensions.x.getName()}: ${this.cubeDimensions.x.getIndexString(this.hoverData.x)}${this.context.debugMode ? ` (X / ${this.hoverData.x})` : ""}`);
        if (this.context.debugMode) {
            lines.push(`Max. error introduced by compression in this tile: ${this.hoverData.maximumCompressionError}`)
            if (this.hoverData.face !== undefined) { 
                lines.push(`Face: ${CubeFace[this.hoverData.face]} (${this.hoverData.face})`);
                lines.push(`Tile2D x: ${this.hoverData.tileX} y: ${this.hoverData.tileY}, Pixel x: ${this.hoverData.localTilePixelX} y: ${this.hoverData.localTilePixelY}`)
            } else {
                lines.push(`Tile3D x: ${this.hoverData.tileX} y: ${this.hoverData.tileY} z: ${this.hoverData.tileZ}, Voxel local x: ${this.hoverData.localTilePixelX} y: ${this.hoverData.localTilePixelY} z: ${this.hoverData.localTilePixelZ}`)
            }
            lines.push(`Display Quality: ${(100*Math.pow(0.5, this.hoverData.lod)).toFixed(2)}% (LoD ${this.hoverData.lod})`);
        }

        let html = "";
        for (const line of lines) {
            const color = line.indexOf("failed") > -1 ? "#ff4444" : "white";
            html += `<div style='color: ${color}'>${line}</div>`
        }
        this.hoverInfoDiv.innerHTML = html;
    }

    private changeHoverInfoUiVisibility(visible: boolean) {
        if (visible) {
            this.hoverInfoDiv.style.display = "block";
        } else {
            this.hoverInfoDiv.style.display = "none";
        }
    }

    private clearColormapRangeUi() {
        this.colormapUi.clearRangeUi();
    }

    updateColormapRangeUiFromValues() {
        this.colormapUi.updateRangeFromValues();
    }

    updateColormapRangePlaceholders() {
        this.colormapUi.updateRangePlaceholders();
    }

    // Rounds to significant digits
    toFixed(float: number): string {
        return `${Number((roundToSparsity(float, Math.pow(10, -this.floatDisplaySignificance))).toFixed(this.floatDisplaySignificance))}`;
    }

    toFixedNumber(float: number): number {
        return Number(float.toFixed(this.floatDisplaySignificance));
    }
    
    getConvertedDataValue(value: number, fromTile3d: boolean = false): number {
        if (isNaN(value) || (value === ((this.context.useHalfFloatsForTile3d && fromTile3d) ? HALF_FLOAT_NAN_REPLACEMENT_VALUE : FLOAT_NAN_REPLACEMENT_VALUE))) { // does not check NaN factor mask
            return NaN;
        }
        return this.toFixedNumber(this.selectedParameter.getConvertedDataValue(value));
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

        const isExpanding3dStorage = this.context.rendering.volumeRenderingEnabled && !this.context.tileData.isTexture3dAllocated(this.context.rendering.lod3d);

        if (isExpanding3dStorage) {
            lines.push("Expanding 3D data storage...");
        } else if ((downloadsFinished + downloadsFailed) != downloadsTriggered) {
            const n = downloadsTriggered - (downloadsFinished + downloadsFailed);
            if (this.context.expertMode) {
                lines.push(`${n} tile${n == 1 ? "" : "s"} downloading...`);
            } else if (this.context.widgetMode) {
                const percentage = Math.round(downloadsTriggered / downloadsFinished * 100);
                lines.push(`Accessing data (${percentage}%)...`);
                if (this.requestProgressTimingEnabled) {
                    const p = downloadsTriggered / downloadsFinished;
                    const now = performance.now();
                    const overestimationFactor = lerp(1.3, 1.0, p); // overestimate at the beginnning
                    const overestimationFlat = lerp(1000, 0, p);
                    const estimatedFinishTime = overestimationFactor * (this.requestProgressLastUpdate - this.requestProgressStart) / p + this.requestProgressStart + overestimationFlat;
                    const estimatedRemainingTime = estimatedFinishTime - now;
                    const estimatedRemainingTimeSeconds = Math.max(Math.round(estimatedRemainingTime / 1000), 1);
                    if (p < 1 && p > 0) {
                        if (estimatedRemainingTimeSeconds < 3) {
                            lines.push(`<i>less than 3 seconds remaining</i>`);
                        } else {
                            lines.push(`<i>ca. ${estimatedRemainingTimeSeconds} second${estimatedRemainingTimeSeconds != 1 ? "s" : ""} remaining</i>`);
                        }
                        window.setTimeout(() => {
                            this.updateStatusMessage();
                        }, 1000);
                    }
                }
            } else {
                lines.push("Loading...");
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

        if (this.connectionLostMessageVisible) {
            lines.push("It seems the server connection was lost.<br>Please reconnect to the internet.");
        }

        if (lines.length > 0) {
            this.statusMessageDiv.style.display = "inline-block";
            let html = "";
            for (const line of lines) {
                const color = line.indexOf("version") > -1 ? "#48eeff" : ((line.indexOf("failed") > -1 || line.indexOf("went wrong") > -1) ? "#ff4444" : "white");
                html += `<div style='color: ${color}'>${line}</div>`
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
        this.setupExtremeEventUi();

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

        // Delegate event handlers to UI managers
        this.colormapUi.setupEventHandlers(() => this.updateColormapOverrideRangesFromUi());
        this.animationUi.setupEventHandlers();
        this.animationRecordingSupported = true;

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

        if (this.context.orchestrationMasterMode) {
            this.htmlFullscreenButton.style.display = "none";
            this.htmlGpsButton.style.display = "none";
            this.htmlDataSelectButton.style.display = "none";
            this.htmlDataSelectUi.style.display = "block";
            this.htmlDataSelectUi.children[1].remove();
            this.htmlDataSelectUi.children[0].remove();
            this.htmlDownloadPrintTemplateButton.style.display = "none";
            this.animationUi.hideRecordingSection();
        }

        

        this.htmlParent.addEventListener("fullscreenchange", (event) => {
            this.fullscreenActive = (document.fullscreenElement !== null);
            this.context.rendering.onWindowResize();
        });

        window.onkeydown = ((ev: KeyboardEvent) => {
            if (this.context.orchestrationMinionMode && ev.key == "5") {
                this.htmlParent.requestFullscreen().catch((e: any) => {
                    console.error("Could not enter fullscreen mode:", e);
                });
            }
        })

        this.htmlEnableVolumeVizButton.onclick = () => {
            this.enableVolumeVisualization();
        }

        this.htmlDisableVolumeVizButton.onclick = () => {
            this.disableVolumeVisualization();
        }

        // this.volumeVizRenderStyleSelect.onchange = () => {
        //     this.updateVolumeVizRenderStyleFromUi();
        // };

        if (this.context.studioMode && !this.context.widgetMode) {
            this.htmlDownloadImageButton.onclick = () => {
                this.context.rendering.downloadScreenshotFromUi(true);
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
            this.htmlDownloadDatasetSubsetButton.onclick = async () => {
                if (this.downloadSubsetInProgress) {
                    return;
                }
                try {
                    this.htmlDownloadDatasetSubsetButton.style.backgroundImage = "url('spin.gif')";
                    this.downloadSubsetInProgress = true;
                    const xRange = this.cubeSelection.getSelectionRangeByDimension(Dimension.X);
                    const yRange = this.cubeSelection.getSelectionRangeByDimension(Dimension.Y);
                    const zRange = this.cubeSelection.getSelectionRangeByDimension(Dimension.Z);
                    await this.context.networking.downloadDatasetSubset(this.selectedCube.id, this.selectedParameterId, xRange.min, xRange.max, yRange.min, yRange.max, zRange.min, zRange.max);
                } catch (e) {
                    window.alert(`Could not download dataset subset - ${e}.`);
                    console.error("Could not download dataset subset:", e);
                } finally {
                    this.downloadSubsetInProgress = false;
                    this.htmlDownloadDatasetSubsetButton.style.backgroundImage = "url('download.svg')";
                }
            }
        }


        this.htmlTimeSeriesCloseButton.onclick = () => {
            this.removeAllTimeSeries();
        }

        this.datasetInfoDialogWrapperDiv.onclick = () => this.datasetInfoDialogWrapperDiv.style.display = "none";
        this.getHtmlElementByClassName("dataset-info-window")!.onclick = (ev) => { ev.stopPropagation(); };
    }
    
    updateVolumeVizRenderStyleFromUi() {
        // if (this.volumeVizRenderStyleSelect.value == "2") {
        //     this.sliderUi.volumeVizThresholdSliderDiv.style.display = "block";
        //     this.sliderUi.volumeVizThresholdSliderLabelDiv.style.display = "block";
        //     // this.sliderUi.volumeVizThresholdSignSelectRadioParent.style.display = "flex";
        // } else {
        //     this.sliderUi.volumeVizThresholdSliderDiv.style.display = "none";
        //     this.sliderUi.volumeVizThresholdSliderLabelDiv.style.display = "none";
        //     // this.sliderUi.volumeVizThresholdSignSelectRadioParent.style.display = "none";
        // }
        // this.context.rendering.setVolumeRenderStyle(parseInt(this.volumeVizRenderStyleSelect.value));
    }

    private volumeVizAvailable: boolean = false;

    enableVolumeVisualization() {
        if (!this.volumeVizAvailable) {
            return;
        }
        this.htmlEnableVolumeVizButton.style.display = "none";
        this.htmlDisableVolumeVizButton.style.display = "block";
        this.htmlVolumeVizSection.style.display = "flex";
        window.setTimeout(() => { // allow UI to refresh
            this.context.rendering.toggleVolumeRenderingMode(true);
        }, 1);
    }

    disableVolumeVisualization() {
        this.htmlEnableVolumeVizButton.style.display = this.volumeVizAvailable ? "block" : "none"; 
        this.htmlDisableVolumeVizButton.style.display = "none";
        this.htmlVolumeVizSection.style.display =  "none";
        this.context.rendering.toggleVolumeRenderingMode(false);
    }

    showAnimationSettingsHover(hideIfAlreadyShown: boolean = false) {
        this.animationUi.showDropdown(hideIfAlreadyShown);
    }

    hideMenusForTouchDevices() {
        this.animationUi.hideDropdown();
        this.colormapUi.htmlColormapOptions.style.display = "none";
    }

    private startRecordingAnimation() {
        this.animationUi.startRecordingUi();
        this.context.rendering.startRecordingAnimation(this.animationParameters.getFps());
    }

    private stopRecordingAnimation() {
        this.animationUi.stopRecordingUi();
        this.context.rendering.stopRecordingAnimation();
    }

    private startAnimation() {
        this.context.log("Starting animation");
        this.animationEnabled = true;
        if (this.context.orchestrationMasterMode) {
            this.context.networking.pushOrchestratorAnimationUpdate(true);
        }
        this.animationFinishRequested = false;
        this.animationUi.disableControlsDuringAnimation();
        this.animationParameters.resetStep();
        if (this.recordAnimation) {
            this.startRecordingAnimation();
        }
        this.animationUi.showStopButton(this.recordAnimation);
        this.attemptNextAnimationStep(true);
    }

    private stopAnimation() {
        if (this.animationFinishRequested) {
            return;
        }
        this.context.log("Stopping animation");
        this.animationFinishRequested = true;
        if (this.context.orchestrationMasterMode) {
            this.context.networking.pushOrchestratorAnimationUpdate(false);
        }
        this.animationUi.enableControlsAfterAnimation();
        this.animationUi.showStartButton();
        if (this.recordAnimation) {
            this.stopRecordingAnimation();
            this.animationUi.showRecordingProcessingState();
        }
    }

    resetAnimationRecordingUiPostDownload() {
        this.animationUi.resetRecordingUiPostDownload();
    }

    private gpsPositionReceived(position: { coords: { latitude: number, longitude: number } }) {
        const crd = position.coords;
        const relativeLatitude = this.cubeDimensions.getGeospatialTotalRangeY().relativeWithin(-crd.latitude);
        const relativeLongitude = this.cubeDimensions.getGeospatialTotalRangeX().relativeWithin(crd.longitude);
        const threshold = 0.2;
        if (relativeLatitude < -threshold || relativeLongitude < -threshold || relativeLatitude > 1 + threshold || relativeLongitude > 1 + threshold) {
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
        navigator.geolocation.clearWatch(this.gpsTrackingId);
        this.context.rendering.requestRender(false);
    }

    private updateAnimationSliders() {
        this.sliderUi.updateAnimationSliders();
    }

    private updateAnimationDurationLabel() {
        this.sliderUi.updateAnimationDurationLabel();
    }

    private resetTimeSeries() {
        this.timeSeries = [];
    }

    private prepareTimeSeriesChart() {
        Chart.defaults.color = 'white';
        
        (Tooltip.positioners as any).aboveChart = (items: readonly ActiveElement[])  => {
            if (items.length === 0) {
                return false;
            }
            const chart = this.timeSeriesChart;
            
            return {
                x: items[0].element.x,
                y: chart.chartArea.bottom,
                xAlign: 'center',
                yAlign: 'top'
            };
        };
        this.timeSeriesChart = new Chart(this.htmlTimeSeriesCanvas, {
            type: "line",
            data: {
                labels: [],
                datasets: []
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                scales: {
                    x: {
                        grid: {
                            color: '#ffffff6d',
                        },
                        ticks: {
                            maxTicksLimit: 8,
                        }
                    },
                    y: {
                        ticks: {
                            autoSkip: true,
                            maxTicksLimit: 8,
                            callback: (value, index, values) => {
                                if (typeof value === "string") {
                                    return value;
                                }
                                const tickDifference = values.length > 1 ? Math.abs(values[1].value - values[0].value) : 0;
                                const significantDigits = tickDifference > 0 ? Math.max(0, -Math.floor(Math.log10(tickDifference))) : this.floatDisplaySignificance;
                                const unit = this.selectedParameter ? this.selectedParameter.getUnit() : "";
                                return `${value.toFixed(significantDigits)}${unit}`;
                            }
                        },
                        grid: {
                            color: '#ffffff6d',
                        },
                    }
                },
                animation: {
                    duration: 500,
                },
                plugins: {
                    tooltip: {
                        position: "aboveChart" as any,
                        multiKeyBackground: '#00000000',
                        usePointStyle: true,
                        boxWidth: 10,
                        boxHeight: 10,
                        callbacks: {
                            labelColor: (context) => {
                                return {
                                    borderColor: context.dataset.borderColor as string,
                                    backgroundColor: context.dataset.borderColor as string,
                                };
                            },
                        }
                        
                    },
                    legend: {
                        display: false,
                    }
                }
            }
        });
    }

    // prevent mousedown + touchstart event in same frame
    private checkContextLayerInteractionCooldown() { 
        if (Date.now() - this.lastContextLayerInteraction < this.CONTEXT_LAYER_INTERACTION_COOLDOWN_MS) {
            return false;
        }
        this.lastContextLayerInteraction = Date.now();
        return true;
    }

    private createOrDeleteTimeSeries(face: CubeFace, uv: Vector2) {
        if (!this.checkContextLayerInteractionCooldown()) {
            return;
        }
        const pickedValue = new PickedDataValue().setFrom2dTileData(this.cubeSelection, this.cubeDimensions, this.context.rendering, this.context.tileData, this.selectedCube.id, this.selectedParameterId, face, uv);
 
        const xRange = this.cubeDimensions.getParameterRangeByDimension(Dimension.X);
        const yRange = this.cubeDimensions.getParameterRangeByDimension(Dimension.Y);

        // round to sparsity since otherwise we have no tiles available to fill the time series
        const nearestValidX = roundToSparsityWithinRange(Math.floor(pickedValue.x), this.selectedCubeMetadata.sparsity, xRange.min, xRange.max - 1);
        const nearestValidY = roundToSparsityWithinRange(Math.floor(pickedValue.y), this.selectedCubeMetadata.sparsity, yRange.min, yRange.max - 1);

        const existingTimeSeriesAtThisPosition = this.timeSeries.find(ts => ts.x == nearestValidX && ts.y == nearestValidY);
        if (existingTimeSeriesAtThisPosition) {
            this.removeTimeSeries(existingTimeSeriesAtThisPosition.id);
            return;
        }
        this.addTimeSeries(face, nearestValidX, nearestValidY);
    }

    private updateTimeSeriesChart() {
        this.timeSeriesChart.options.plugins!.tooltip!.callbacks!.label = (context) => {
            return `${context.parsed.y}${this.selectedParameter.getUnit()}`; //  (${context.dataset.label})
        }    

        const timeSteps = this.cubeDimensions.z.steps;
        const timeLabels = range(0, timeSteps - 1).map((_, i) => this.cubeDimensions.z.getIndexString(i));
        
        this.timeSeriesChart.data.labels = timeLabels;

        for (let i = 0; i < this.timeSeries.length; i++) {
            const ts = this.timeSeries[i];
            if (i >= this.timeSeriesChart.data.datasets.length) {
                this.timeSeriesChart.data.datasets.push({
                    data: [],
                    fill: false,
                    borderColor: ts.getPointColor(),
                    borderWidth: 1.5,
                    pointHoverRadius: 4,
                    hoverBorderWidth: 2,
                    hoverBorderColor: "white",
                    hoverBackgroundColor: "transparent",
                    tension: 0.0,
                    pointStyle: "circle",
                    pointRadius: 0,
                    pointHitRadius: 7,
                    pointBorderColor: ts.getPointColor(),
                    animation: false,
                });
            }
            const ds = this.timeSeriesChart.data.datasets[i];
            if (!ts.data || ts.data.length === 0) {
                const lonString = this.cubeDimensions.x.getIndexString(ts.x);
                const latString = this.cubeDimensions.y.getIndexString(ts.y);
                ds.label = `@ ${latString}, ${lonString}`;
                ts.data = Array(timeSteps).fill(NaN);
            }
            ds.data = ts.data;
            ds.borderColor = ts.getPointColor();
            ds.pointBorderColor = ts.getPointColor();
        }

        if (this.timeSeries.length < this.timeSeriesChart.data.datasets.length) {
            this.timeSeriesChart.data.datasets.splice(this.timeSeries.length, this.timeSeriesChart.data.datasets.length - this.timeSeries.length);
        }

        this.htmlTimeSeriesDiv.style.display = this.timeSeries.length > 0 ? "block" : "none";
        this.timeSeriesChart.update("none");
    }

    updateTimeSeriesChartPosition() {
        if (!this.htmlTimeSeriesDiv) {
            return;
        }
        if (this.context.screenOrientation == DeviceOrientation.Landscape) {
            this.htmlTimeSeriesDiv.style.width = "25%";
            this.htmlTimeSeriesDiv.style.height = this.context.widgetMode ? "42%" : "32%";
            this.htmlTimeSeriesDiv.parentElement?.classList.add("flex-row-center-end");
            this.htmlTimeSeriesDiv.parentElement?.classList.remove("flex-col-center-end");
        } else {
            this.htmlTimeSeriesDiv.style.width = "95%";
            this.htmlTimeSeriesDiv.style.height = "24%";
            this.htmlTimeSeriesDiv.parentElement?.classList.add("flex-col-center-end");
            this.htmlTimeSeriesDiv.parentElement?.classList.remove("flex-row-center-end");
        }
    }

    updateTimeSeriesSelectionBounds() {
        if (Object.keys(this.timeSeriesChart.scales).length == 0) {
            return; // chart not initialized yet
        }
        const zSelection = this.cubeSelection.getSelectionRangeByDimension(Dimension.Z);
        const newMin = zSelection.min;
        const newMax = zSelection.max - 1;
        if (this.timeSeriesChart.scales.x.options.min === newMin && this.timeSeriesChart.scales.x.options.max === newMax) {
            return; // no change
        }
        this.timeSeriesChart.scales.x.options.min = newMin;
        this.timeSeriesChart.scales.x.options.max = newMax;
        this.timeSeriesChart.update('none');
    }

    private getAvailableTimeSeriesColor(): string {
        const pointColors = [
            '#E69F00',  // Orange
            '#56B4E9',  // Sky Blue
            '#009E73',  // Bluish Green
            '#0072B2',  // Blue
            '#D55E00',  // Vermilion
            '#CC79A7',  // Reddish Purple
            '#999999',  // Gray
        ];

        // find the next color that is not used yet
        for (let i = 0; i < pointColors.length; i++) {
            const color = pointColors[i];
            let colorInUse = false;
            for (const ts of this.timeSeries) {
                if (ts.getPointColor() == color) {
                    colorInUse = true;
                    break;
                }
            }
            if (!colorInUse) {
                return color;
            }
        }
        throw new Error("All point colors are already in use");
    }

    private readonly MAXIMUM_TIME_SERIES = 7;

    private addTimeSeries(face: CubeFace, x: number, y: number) {
        if (this.timeSeries.length >= this.MAXIMUM_TIME_SERIES) {
            this.removeTimeSeries(this.timeSeries[0].id);
        }

        const series = new TimeSeries(face, x, y, this.getAvailableTimeSeriesColor());
        this.timeSeries.push(series);
        this.updateTimeSeriesChart();

        series.marker = this.context.rendering.addTimeSeriesMarker(series.id, face, x, y, series.getPointColor());
        this.context.rendering.updateRegionBorderPositionAndResolution();
        this.context.tileData.requestTimeSeriesData(series.id, series.getRequestedDataRange(), this.cubeDimensions.getParameterRangeByDimension(Dimension.Z));
    }

    private removeAllTimeSeries() {
        for (let i = this.timeSeries.length - 1; i >= 0; i--) {
            this.removeTimeSeries(this.timeSeries[i].id);
        }
    }

    private removeTimeSeries(id: number) {
        this.context.log("Removing time series id ", id);
        const index = this.timeSeries.findIndex(ts => ts.id == id);
        if (index >= 0) {
            const ts = this.timeSeries[index];
            this.timeSeries.splice(index, 1);
            if (ts.marker) {
                this.context.rendering.removeTimeSeriesMarker(ts.marker);
                this.context.rendering.requestRender(false);
            }
        } else {
            console.error("removeTimeSeries: Could not find time series with id ", id);
        }
        this.updateTimeSeriesChart();
    }

    getTimeSeries(timeSeriesId: number) {
        return this.timeSeries.find(ts => ts.id == timeSeriesId);
    }

    updateTimeSeriesData(timeSeriesId: number, newData: number[], zStart: number) {
        if (!this.timeSeries) {
            console.warn("updateTimeSeriesData: No time series object created yet");
            return;
        }
        const ts = this.getTimeSeries(timeSeriesId);
        if (!ts) {
            console.error("updateTimeSeriesData: Could not find time series with id ", timeSeriesId);
            return;
        }
        const complete = ts.insertData(newData, zStart, this);
        this.context.log(`Updated time series id ${timeSeriesId} with data of length ${Math.min(newData.length, ts.data.length - zStart)} starting at Z index ${zStart}`);
        
        if (complete) {
            this.timeSeriesChart.update("none");
        }
        // this.updateTimeSeriesSelectionBounds();
    }

    private highlightTimeSeries(timeSeriesId: number) {
        const yMin = this.timeSeriesChart.scales.y.min;
        const yMax = this.timeSeriesChart.scales.y.max;
        for (let i = 0; i < this.timeSeries.length; i++) {
            const ts = this.timeSeries[i];
            const hidden = ts.id !== timeSeriesId;
            this.timeSeriesChart.data.datasets[i].borderColor = ts.getPointColor() + (hidden ? "33" : "");
        }
        this.timeSeriesChart.scales.y.options.min = yMin;
        this.timeSeriesChart.scales.y.options.max = yMax;
        this.timeSeriesChart.update();
    }

    private unhighlightTimeSeries() {
        for (let i = 0; i < this.timeSeries.length; i++) {
            const ts = this.timeSeries[i];
            this.timeSeriesChart.data.datasets[i].borderColor = ts.getPointColor();
        }
        this.timeSeriesChart.scales.y.options.min = undefined;
        this.timeSeriesChart.scales.y.options.max = undefined;
        this.timeSeriesChart.update();
    }
    
    private updateSliderLabels() {
        this.sliderUi.updateDimensionSliderLabels();
    }

    private updateSelectionUiRangeBounds() {
        this.sliderUi.updateSelectionRangeBounds();
    }

    private currentParameterHasExtremesAvailable() {
        return false;
    }

    private selectExtremeEventTypeByCharacteristics(thresholdTarget: ExtremeThresholdTarget | undefined, thresholdType: ExtremeThresholdType | undefined, spatialQuantileContext: ExtremeSpatialQuantileContext | undefined) {
        // select the next available extreme event type
        if (!this.currentParameterHasExtremesAvailable()) {
            return;
        }

        const t = this.availableExtremeTypes.find(extremeType => {
            const seekedTarget = (thresholdTarget ?? this.currentExtremeType.thresholdTarget);
            const seekedType = (thresholdType ?? this.currentExtremeType.thresholdType);
            const seekedContext = (spatialQuantileContext ?? this.currentExtremeType.spatialQuantileContext);
            
            if (seekedType == ExtremeThresholdType.Absolute) {
                return extremeType.thresholdTarget == seekedTarget &&
                    extremeType.thresholdType == seekedType;
            }
            
            // AllTimeSeries desired if no SpatialContext but we need one for quantile
            if (seekedContext == undefined) {
                return extremeType.thresholdTarget == seekedTarget &&
                    extremeType.thresholdType == seekedType &&
                    extremeType.spatialQuantileContext == ExtremeSpatialQuantileContext.AllTimeSeries;
            }
            
            return extremeType.thresholdTarget == seekedTarget &&
                extremeType.thresholdType == seekedType &&
                extremeType.spatialQuantileContext == seekedContext;
        });

        if (!t) {
            console.warn("Could not find extreme event type with characteristics ", { thresholdTarget, thresholdType, spatialQuantileContext });
            return;
        }

        this.setExtremeEventType(t);
    }

    private setupExtremeEventUi() {
        if (this.context.widgetMode) {
            return;
        }
        this.htmlVolumeVizThresholdTarget.onclick = () => {
            console.log(`current threshold target: ${this.currentExtremeType.thresholdTarget}, cycling to next..., (${Object.keys(ExtremeThresholdTarget).length} total)`);
            this.selectExtremeEventTypeByCharacteristics(
                (this.currentExtremeType.thresholdTarget + 1) % (Object.keys(ExtremeThresholdTarget).length / 2), 
                undefined, 
                undefined
            );
        };

        this.htmlVolumeVizThresholdType.onclick = () => {
            this.selectExtremeEventTypeByCharacteristics(
                undefined, 
                (this.currentExtremeType.thresholdType + 1) % (Object.keys(ExtremeThresholdType).length / 2), 
                undefined
            );
        }

        this.htmlVolumeVizThresholdSpatialQuantileContext.onclick = () => {
            if (this.currentExtremeType.thresholdType != ExtremeThresholdType.Quantile || this.currentExtremeType.spatialQuantileContext == null) {
                return;
            }
            this.selectExtremeEventTypeByCharacteristics(
                undefined, 
                undefined, 
                (this.currentExtremeType.spatialQuantileContext + 1) % (Object.keys(ExtremeSpatialQuantileContext).length / 2)
            );
        }
    }

    private setExtremeEventType(extremeType: ExtremeType) {
        this.currentExtremeType = extremeType;
        this.setVolumeRenderingUseQuantileOverAbsoluteThreshold(extremeType.thresholdType == ExtremeThresholdType.Quantile);
        this.updateExtremeTypeText();
    }

    private updateExtremeTypeText() {
        if (!this.selectedParameter) {
            return;
        }
        // update UI based on currentExtremeType
        this.htmlVolumeVizThresholdTarget.innerHTML = this.currentExtremeType.thresholdTarget == ExtremeThresholdTarget.Observations ? "observations" : "anomalies (deviations from mean seasonal cycle)";
        const thresholdPrefix = this.getVolumeRenderingThresholdSign() == -1 ? "below" : (this.getVolumeRenderingThresholdSign() == 1 ? "above" : "equals");
        const absoluteThresholdString = `${this.toFixed(this.getVolumeRenderingAbsoluteThreshold())}${this.selectedParameter.getUnit()}`;
        const quantileThresholdString = `the ${(this.getVolumeRenderingQuantileThresholdValue()*100).toFixed(0)}th percentile`;
        this.htmlVolumeVizThresholdType.innerHTML = thresholdPrefix + " " + (this.currentExtremeType.thresholdType == ExtremeThresholdType.Quantile ? quantileThresholdString : absoluteThresholdString);
        this.htmlVolumeVizThresholdSpatialQuantileContext.innerHTML = this.currentExtremeType.spatialQuantileContext == ExtremeSpatialQuantileContext.AllTimeSeries ? "across all locations" : (this.currentExtremeType.spatialQuantileContext == ExtremeSpatialQuantileContext.PcaGroupedTimeSeries ? "across phenologically similar locations (grouped via a PCA)" : "in their location");
        this.htmlVolumeVizThresholdSpatialQuantileContext.style.display = this.currentExtremeType.thresholdType == ExtremeThresholdType.Quantile ? "" : "none";
    }

    private resetExtremeEventTypeAndUi() {
        this.setExtremeEventType(this.availableExtremeTypes[0]);

        const extremesAvailable = this.currentParameterHasExtremesAvailable();

        if (extremesAvailable) {
            this.context.networking.downloadEventData(this.selectedCube.id, this.selectedParameterId, "QLO_i0_q0.01"); // todo
        }

        this.htmlVolumeVizDescriptionRow.style.display = extremesAvailable ? "" : "none";
    }

    updateVolumeVizVisibilityThresholdBounds(setThreshold: boolean = false) {
        if (!setThreshold && !this.context.widgetMode) {
            return;
        }
        const colormapMin = this.context.tileData.getColormapMinValue();
        const colormapMax = this.context.tileData.getColormapMaxValue();
        const desiredMin = (colormapMin !== null && colormapMin != colormapMax) ? colormapMin : (this.selectedParameter.realisticMinimumValueViaQuantiles !== undefined ? this.selectedParameter.realisticMinimumValueViaQuantiles : (this.context.tileData.observedMinValue !== null ? this.context.tileData.observedMinValue : NaN));
        const desiredMax = (colormapMax !== null && colormapMin != colormapMax) ? colormapMax : (this.selectedParameter.realisticMaximumValueViaQuantiles !== undefined ? this.selectedParameter.realisticMaximumValueViaQuantiles : (this.context.tileData.observedMaxValue !== null ? this.context.tileData.observedMaxValue : NaN));
        const newRange = {
            min: Math.floor(desiredMin),
            max: Math.ceil(desiredMax),
        }
        if (this.selectedParameter.isAnomalyParameter()) {
            const p = Math.max(Math.abs(this.selectedParameter.realisticMinimumValueViaQuantiles), Math.abs(this.selectedParameter.realisticMaximumValueViaQuantiles)) * 0.4;
            newRange.min = -Math.floor(p);
            newRange.max = Math.ceil(p);
        }
        const threshold = 0.7 * (this.selectedParameter.realisticMaximumValueViaQuantiles - this.selectedParameter.realisticMinimumValueViaQuantiles) + this.selectedParameter.realisticMinimumValueViaQuantiles;

        const stepBasedOnLocalRange = Math.pow(10, Math.floor(Math.log10((newRange.max - newRange.min) / 100)));
        const stepBasedOnFloatSignificance = Math.pow(10, -this.floatDisplaySignificance);
        const newStep = Math.min(stepBasedOnLocalRange, stepBasedOnFloatSignificance);
        if (isNaN(newRange.min) || isNaN(newRange.max) || isNaN(newStep)) {
            return;
        }

        const newOptions = {
            range: {
                min: newRange.min,
                max: newRange.max,
            },
            step: newStep,
        };

        this.sliderUi.setNewThresholdAndRangeOptions(newOptions);

        if (setThreshold) {
            this.setVolumeRenderingAbsoluteThreshold(threshold);
        }
    }

    private resetVolumeVizVisibilityThresholdBoundsForNewParameter() {
        if (this.context.widgetMode) {
            return;
        }

        this.updateVolumeVizVisibilityThresholdBounds(true); // sets absolute threshold
        this.setVolumeRenderingQuantileThreshold(19);
        this.setVolumeRenderingUseQuantileOverAbsoluteThreshold(false);
        this.setVolumeRenderingThresholdSign(1);
    }

    setVolumeVizUiLoaderVisibility(visible: boolean) {
        this.htmlVolumeVizLoaderColumn.style.display = visible ? "flex" : "none";
        this.htmlVolumeVizMainColumn.style.display = visible ? "none" : "flex";
    }

    getVolumeRenderingAbsoluteThresholdRange() {
        return {
            min: this.sliderUi.volumeVizThresholdSlider.options.range.min as number,
            max: this.sliderUi.volumeVizThresholdSlider.options.range.max as number,
        };
    }

    getVolumeRenderingThresholdSign() {
        return this.context.rendering.getVolumeRenderingShaderThresholdSign();
    }

    getVolumeRenderingAbsoluteThreshold() {
        return this.context.rendering.getVolumeRenderingAbsoluteThreshold();
    }

    getVolumeRenderingQuantileThresholdIndex() {
        return this.context.rendering.getVolumeRenderingQuantileThreshold();
    }

    getVolumeRenderingQuantileThresholdValue() {
        const quantileIndex = this.getVolumeRenderingQuantileThresholdIndex();
        const quantileValue = quantileIndex < NON_EXTREME_QUANTILE_INDEX ? (quantileIndex + 1) * QUANTILE_STEP : 1 - (((NON_EXTREME_QUANTILE_INDEX * 2) - quantileIndex + 1) * QUANTILE_STEP);
        return parseFloat(quantileValue.toFixed(QUANTILE_RELEVANT_DECIMALS));
    }

    getVolumeRenderingUseQuantileOverAbsoluteThreshold() {
        return this.context.rendering.getVolumeRenderingUseQuantileOverAbsoluteThreshold();
    }


    toggleThresholdSliderAnimations(enabled: boolean) {
        this.sliderUi.toggleThresholdSliderAnimations(enabled);
    }

    setVolumeRenderingThresholdSign(thresholdSign: number, updateUi: boolean = true) {
        if (updateUi) {
            // not applicable i guess
        }
        
        this.sliderUi.updateVolumeVizThresholdSliderConnects(thresholdSign);
        this.context.rendering.setVolumeRenderingShaderThresholdSign(thresholdSign);
        this.sliderUi.updateSignVisual();
        this.sliderUi.updateSlidersVisibility(this.getVolumeRenderingUseQuantileOverAbsoluteThreshold());
        this.updateExtremeTypeText();
    }

    setVolumeRenderingAbsoluteThreshold(newThreshold: number, updateSliderUi: boolean = true) {
        if (updateSliderUi) {
            this.sliderUi.volumeVizThresholdSlider.set(newThreshold, false);
        }
        this.context.rendering.setVolumeRenderingShaderAbsoluteThreshold(newThreshold);
        this.updateExtremeTypeText();
    }

    setVolumeRenderingRange(min: number | null, max: number | null, updateSliderUi: boolean = true) {
        if (updateSliderUi) {
            // this.sliderUi
        }
        
        this.context.rendering.setVolumeRenderingShaderRange(min, max);
        this.updateExtremeTypeText(); // todo
    }

    setVolumeRenderingQuantileThreshold(newQuantile: number, updateSliderUi: boolean = true) {
        if (updateSliderUi) {
            this.sliderUi.volumeVizQuantileSlider.set(newQuantile, false);
        }
        this.context.rendering.setVolumeRenderingShaderQuantileThreshold(newQuantile);
        this.updateExtremeTypeText();
    }

    setVolumeRenderingUseQuantileOverAbsoluteThreshold(useQuantile: boolean, updateSliderUi: boolean = true) {
        if (updateSliderUi) {
            this.sliderUi.updateSlidersVisibility(this.currentExtremeType.thresholdType == ExtremeThresholdType.Quantile)
            this.sliderUi.volumeVizThresholdSlider.updateOptions({}, false);
        }
        this.context.rendering.setVolumeRenderingShaderUseQuantileOverAbsoluteThreshold(useQuantile);
        this.updateExtremeTypeText();
    }

    updateSlidersAndLabelsAfterChange(updateSliders: boolean = true, dimensionsOnly: Dimension[] = []) {
        // this.context.log(`${performance.now()}: updateSlidersAndLabelsAfterChange called (updateSliders=${updateSliders},  dimensionsOnly=${dimensionsOnly})`);
        if (updateSliders) {
            this.updateSliderValuesAfterChange(dimensionsOnly);
        }
        this.updateLabelsAfterChange();
    }

    updateSliderValuesAfterChange(dimensionsOnly: Dimension[] = []) {
        this.sliderUi.updateSliderValuesAfterChange(dimensionsOnly);
    }

    updateLabelsAfterChange() {
        const zSelectionRange = this.cubeSelection.getSelectionRangeByDimension(Dimension.Z);
        const ySelectionRange = this.cubeSelection.getSelectionRangeByDimension(Dimension.Y);
        const xSelectionRange = this.cubeSelection.getSelectionRangeByDimension(Dimension.X);
        const dims = this.cubeDimensions;
        this.htmlAxisLabelXMin.textContent = `${this.cubeDimensions.x.getIndexString(positiveModulo(xSelectionRange.min, dims.x.steps))}`;
        this.htmlAxisLabelXMax.textContent = `${this.cubeDimensions.x.getIndexString(positiveModulo(xSelectionRange.max - 1, dims.x.steps))}`; // prefer showing max value over 0
        this.htmlAxisLabelYMin.textContent = `${this.cubeDimensions.y.getIndexString(ySelectionRange.min)}`;
        this.htmlAxisLabelYMax.textContent = `${this.cubeDimensions.y.getIndexString(ySelectionRange.max - 1)}`;
        this.htmlAxisLabelZMin.textContent = `${this.cubeDimensions.z.getIndexString(zSelectionRange.min)}`;
        this.htmlAxisLabelZMax.textContent = `${this.cubeDimensions.z.getIndexString(zSelectionRange.max - 1)}`;
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
            // cornerLineSmall(`<div>When using Lexcube and/or generated images or videos, please acknowledge/cite: M. Söchting et al., doi: <a href="https://doi.org/10.1109/MCG.2023.3321989" target="blank" onclick="return true">10.1109/MCG.2023.3321989</a>.</div>`);
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
        dialogParameterValue("A PhD project by Maximilian Söchting; advisors Miguel Mahecha & Gerik Scheuermann, Leipzig University, a collaboration between the Environmental Data Science and Remote Sensing group (Institute for Earth System Science and Remote Sensing) and the Image and Signal Processing Group (Institute for Computer Science). Lexcube is also available for Jupyter notebooks on <a target='_blank' href='https://www.github.com/msoechting/lexcube'>GitHub</a>. Region borders from Natural Earth.")
        dialogParameterHeading("Funding")
        dialogParameterValue("This project is supported by the National Research Data Infrastructure for Earth System Sciences NFDI4Earth (pilot projects), the German Science Foundation (DFG) and the European Space Agency (ESA) via the DeepExtremes and DeepESDL projects.")
        // dialogParameterValue("<hr>");
        // dialogParameterHeading("Attribution")
        // dialogParameterValue(`<b>When using Lexcube-generated images acknowledge/cite</b>: M. Söchting, M. D. Mahecha, D. Montero and G. Scheuermann, "Lexcube: Interactive Visualization of Large Earth System Data Cubes," in IEEE Computer Graphics and Applications, doi: https://www.doi.org/10.1109/MCG.2023.3321989.`)

        for (let line of dialogLines) {
            dialogHtml += `${line}`
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
        this.disableAllLinksInOrchestrationMasterMode();
    }

    private parameterBeingSelected = false;

    selectParameter(parameterId: string, cubeChanged: boolean = false) {
        if (this.parameterBeingSelected || !this.cubeParameters.has(parameterId)) {
            console.error("Could not select", parameterId);
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
        this.context.rendering.createTileTextureViews();
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
            this.context.rendering.tile2dFaceRenderedCube.position.copy(position);
        }

        this.context.tileData.resetDataStatistics();
        this.context.tileData.resetTextureFiltering();

        this.cubeDimensions.setInitialParameterRanges(this.selectedParameter.parameterCoverageTime);
        this.sliderUi.resetOverflowXSliderIndex();

        this.currentZoomFactor = [1.0, 1.0, 1.0];
        this.previousZoomFactor = [1.0, 1.0, 1.0];

        this.context.log(this.cubeDimensions);

        this.cubeSelection = new CubeSelection(this.context);
        this.updateSelectionUiRangeBounds();

        this.reconstructAllZoomFactors();
        this.context.rendering.resetForNewParameter();
        this.context.tileData.setDataType(this.selectedParameter.dataType);
        this.context.rendering.setDataType(this.selectedParameter.dataType);
        this.context.tileData.allocateTile2dStorages(cubeChanged);
        this.context.tileData.allocateTile3dStorages(cubeChanged);
        this.context.tileData.resetTileMaps();
        this.context.tileData.symmetricalColormapAroundZero = false;
        this.updateDatasetInfoAndShow(true, false);
        this.fullyLoaded = true;
        this.context.rendering.updateRegionBorderPositionAndResolution();

        this.resetTimeSeries();
        this.clearColormapRangeUi();
        
        if (!this.context.widgetMode) {
            if (this.selectedParameter.fixedColormapMinimumValue !== undefined) {
                this.colormapUi.setMinInputValue(`${this.selectedParameter.fixedColormapMinimumValue}`);
            } else if (this.cubeTags.includes(CubeTag.ColormappingFromObservedValues)) {
                this.colormapUi.setMinInputValue("");
            } else {
                const globalMin = this.selectedParameter.isAnomalyParameter() ? this.selectedParameter.minimumValue : this.selectedParameter.realisticMinimumValueViaQuantiles;
                this.colormapUi.setMinInputValue(`${globalMin}`);
            }

            if (this.selectedParameter.fixedColormapMaximumValue !== undefined) {
                this.colormapUi.setMaxInputValue(`${this.selectedParameter.fixedColormapMaximumValue}`);
            } else if (this.cubeTags.includes(CubeTag.ColormappingFromObservedValues)) {
                this.colormapUi.setMaxInputValue("");
            } else {
                const globalMax = this.selectedParameter.isAnomalyParameter() ? this.selectedParameter.maximumValue : this.selectedParameter.realisticMaximumValueViaQuantiles;
                this.colormapUi.setMaxInputValue(`${globalMax}`);
            }
        }

        this.context.tileData.ignoreStatisticalColormapBounds = false;
        // if (this.context.rendering.volumeVizModeEnabled) {
        //     this.context.tileData.symmetricalColormapAroundZero = true;
        //     this.context.tileData.ignoreStatisticalColormapBounds = true;
        //     const p = 10;
        //     this.context.tileData.colormapMaxValueOverride = p;
        //     this.context.tileData.colormapMinValueOverride = -p;
        //     this.htmlColormapMinInputDiv.value = `-${p}`;
        //     this.htmlColormapMaxInputDiv.value = `${p}`;
        //     this.selectColormapByName("balance");
        //     this.context.tileData.setColormapFlipped(this.selectedParameter.higherAnomalyIsBlueInsteadOfRed());
        // } else
        if (this.selectedParameter.fixedColormap !== undefined) {
            const flipped = (this.selectedParameter.fixedColormapFlipped !== undefined && this.selectedParameter.fixedColormapFlipped)
            this.context.tileData.setColormapFlipped(flipped);
            this.selectColormapByName(this.selectedParameter.fixedColormap);
        } else {
            // reset colormap flipped
            if (!this.context.widgetMode) {
                this.context.tileData.setColormapFlipped(false);
            }

            // select default colormap
            if (this.selectedParameter.isAnomalyParameter()) {
                this.context.tileData.symmetricalColormapAroundZero = true;
                this.context.tileData.ignoreStatisticalColormapBounds = true;
                this.selectColormapByName("balance");
                this.context.tileData.setColormapFlipped(this.selectedParameter.higherAnomalyIsBlueInsteadOfRed())
            } else {
                if (this.context.widgetMode) {
                    this.context.log("Not selecting new colormap on selectParameter (widget mode)")
                } else {
                    this.selectArbitraryLinearColormap(this.htmlParameterSelect.options.selectedIndex + 2);
                }
            }
        }
        this.colormapUi.setFlippedChecked(this.context.tileData.getColormapFlipped());
        this.setVolumeVizUiLoaderVisibility(true);
        this.resetExtremeEventTypeAndUi();
        this.context.rendering.updateVisibilityAndLods();
        if (!this.context.widgetMode) {
            this.updateColormapOverrideRangesFromUi();
        }
        
        
        this.animationParameters = new AnimationParameters(Dimension.Z, this.cubeDimensions, this.selectedCubeMetadata.sparsity, this.updateAnimationDurationLabel.bind(this));
        this.animationParameters.initialize();
        this.animationUi.setSelectedRangeOnlyChecked(false);
        this.updateAnimationSliders();
        this.updateAnimationDimensionSelectLabels();
        this.cubeSelection.updateSelectionRelevantUi();
        this.updateLabelPositions();

        this.resetVolumeVizVisibilityThresholdBoundsForNewParameter();


        this.parameterBeingSelected = false;
        this.initialLoad = false;

        // window.setTimeout(() => {
            
        // this.enableVolumeVisualization(); // debuging
        // }, 500);

        return true;
    }

    async selectCube(logicalDataCube: LogicalDataCube) {
        this.context.log("Select cube", logicalDataCube.id)
        this.fullyLoaded = false;
        this.context.rendering.hideData();
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

        if (this.selectedCubeMetadata.max_lod_2d > MAXIMUM_SUPPORTED_LOD) {
            this.context.warn("Selected cube has a maximum LOD of", this.selectedCubeMetadata.max_lod_2d, "which is higher than the maximum client supported LOD of", MAXIMUM_SUPPORTED_LOD, " - will clamp to", MAXIMUM_SUPPORTED_LOD);
        }
        
        if (this.selectedCube.id.indexOf("anomalies") > -1) {
            this.cubeTags.push(CubeTag.AnomaliesOnly);
        }

        ParameterRange.sparsity = this.selectedCubeMetadata.sparsity;
        this.cubeParameters = new Map<string, Parameter>();
        const isAnomalyDataset = this.cubeTags.includes(CubeTag.AnomaliesOnly);
        for (let parameterId of Object.keys(meta["data_vars"])) {
            const parameterAttributionLookupId = parameterId.endsWith(ANOMALY_PARAMETER_ID_SUFFIX) ? parameterId.substring(0, parameterId.length - ANOMALY_PARAMETER_ID_SUFFIX.length) : parameterId;
            const attribution = this.getAttributionParameterMetadata(parameterAttributionLookupId);
            const parameter = new Parameter(parameterId, this.selectedCubeMetadata.data_vars[parameterId], attribution, this.getColormapParameterMetadata(parameterId), isAnomalyDataset);
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
            meta.indices,
            meta.coords
        );

        const geospatialContext = new GeospatialContext();

        const hainich = this.selectedCube.shortName.indexOf("Hainich") > -1;
        const auwald = this.selectedCube.shortName.indexOf("Auwald") > -1;
        const esdc = this.selectedCube.id.indexOf("esdc") > -1;
        const esdc2 = this.selectedCube.id.indexOf("esdc-2") > -1;
        const esdc3 = this.selectedCube.id.indexOf("esdc-3") > -1;
        const camsEcmwf = this.selectedCube.id.indexOf("cams-eac4") > -1;
        const era5SpecificHumidity = this.selectedCube.id.indexOf("era5-specific-humidity") > -1;

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
            this.context.log("X/Y are longitude/latitude with value ranges > 350 / 170, assuming cube is global.");
            this.cubeTags.push(CubeTag.Global);
            this.cubeTags.push(CubeTag.OverflowX);
            if (this.cubeDimensions.x.getMaxValue() > 350) {
                this.cubeTags.push(CubeTag.LongitudeZeroIndexIsGreenwich);
                this.context.log("Found longitude values > 350, will assume longitude zero index is Greenwich")
            }
        }
        
        let xCorrection = GeospatialContextCorrection.AddHalfStepAtBothEnds;
        let yCorrection = GeospatialContextCorrection.AddHalfStepAtBothEnds;

        if (this.cubeTags.includes(CubeTag.LongitudeZeroIndexIsGreenwich)) { // works so far for CAMS EAC4 and ERA5
            xCorrection = GeospatialContextCorrection.AddFullStepAtEnd;
            yCorrection = GeospatialContextCorrection.None;
        }

        const message = geospatialContext.setFromDimensions(this.cubeDimensions, xCorrection, yCorrection);
        this.context.log("Attempt to set geospatial context from dimensions:", message);

        if (hainich || auwald) {
            this.cubeTags.push(CubeTag.SpectralIndices);
            this.cubeTags.push(CubeTag.ColormappingFromObservedValues);
        }
        if (this.context.widgetMode) {
            this.cubeTags.push(CubeTag.ColormappingFromObservedValues);
        }
        if (hainich) {
            this.cubeTags.push(CubeTag.Hainich);
            geospatialContext.yRange.set(-51.101795642012135, -51.0566772412508);
            geospatialContext.xRange.set(10.4149020992527, 10.487933035725268);
        }
        if (auwald) {
            this.cubeTags.push(CubeTag.Auwald);
            geospatialContext.yRange.set(-51.38971653210468, -51.34204047701096);
            geospatialContext.xRange.set(12.274098103564866, 12.347526267533526);
        }
        if (this.cubeTags.includes(CubeTag.Global) && !geospatialContext.isValid()) {
            if (this.cubeDimensions.y.type != CubeDimensionType.Latitude) {
                console.warn("Y dimension is not Latitude, but trying to use it for guessing global coverage")
            }
            geospatialContext.setGlobalCoverage();
            this.context.log("Guessing geospatial context, assuming equally distributed global coverage")
        }
        this.context.log("Geospatial context provided:", geospatialContext, "isValid:", geospatialContext.isValid());
        this.geospatialContextProvided = geospatialContext.isValid();
        if (geospatialContext.isValid()) {
            this.cubeDimensions.setGeospatialContext(geospatialContext);
        }
        this.context.log("Selected cube meta:", meta);
        this.context.rendering.updateOverflowSettings(this.cubeTags.includes(CubeTag.OverflowX), false, false);
        this.XYdataAspectRatio = this.context.widgetMode ? 1.0 : this.cubeDimensions.x.steps / this.cubeDimensions.y.steps;
        this.context.log("XYdataAspectRatio:", this.XYdataAspectRatio);
        this.context.log("Cube tags:", this.cubeTags.map(a => CubeTag[a]));
        this.updateAvailableParametersUi();

        if (!this.context.widgetMode) {
            this.htmlDownloadDatasetSubsetButton.style.display = this.selectedCubeMetadata.allow_data_downloads ? "block" : "none";
        }
        this.updateVolumeVizAvailability(this.selectedCubeMetadata.enable_3d_tiles);

        this.updateSliderLabels();

        this.animationUi.setDimensionSelectValue("z");

        const firstParameter = this.cubeParameters.get(Array.from(this.cubeParameters.keys())[0])!.name;

        if (this.initialLoad && this.initialSelectionState.parameterId && this.parseInitialParameter()) {
            // parameter will be selected as side effect of parseInitialParameter

        } else if (esdc3) {
            if (this.context.orchestrationMasterMode) {
                this.selectParameter("precipitation_era5", true);
            } else {
                if (!this.selectParameter("air_temperature_2m", true)) {
                    this.selectParameter(firstParameter, true);
                }
            }
        } else if (this.cubeTags.includes(CubeTag.CamsEac4Reanalysis)) {
            this.selectParameter("aod550", true);
        } else {
            this.selectParameter(firstParameter, true);
        }
        if (!this.context.widgetMode) {
            this.updateUrlFragment();
        }
        this.context.log("done selecting cube and parameter, cubeselection:", this.cubeSelection)
    }

    updateVolumeVizAvailability(serverHasEnabled3dTiles: boolean) {
        this.context.log(`Volume viz (3D tiles on server) is ${serverHasEnabled3dTiles ? "available" : "not available"} for this dataset`);
        this.volumeVizAvailable = serverHasEnabled3dTiles;
        this.htmlEnableVolumeVizButton.style.display = this.volumeVizAvailable ? "block" : "none";
        this.disableVolumeVisualization();
    }

    private parseInitialParameter() {
        const s = Array.from(this.cubeParameters.keys()).find(s => s.toLowerCase() == this.initialSelectionState.parameterId);
        if (s) {
            return this.selectParameter(s, true);
        }
        return false;
    }

    applyCameraPreset(presetName: string = "", cameraOverride: OrthographicCamera | undefined = undefined, presetOverride: { position: { x: number, y: number, z: number }; rotation: { x: number, y: number, z: number } } | undefined = undefined, fromWidgetMode: boolean = false): void {        
        const defaultPresetIndex = 3;
        let presetIndex = this.context.scriptedMultiViewMode ? 5 : defaultPresetIndex;
        if (this.context.singleFaceMode) {
            presetIndex = this.cameraPresets.findIndex(c => c.name == `Single Face (${CubeFace[this.context.singleFace]})`)
        } else if (presetName.length > 0) {
            presetIndex = this.cameraPresets.findIndex(c => c.name == presetName);
        } 
        const overridingPreset = (presetOverride ? { "name": `custom preset (${JSON.stringify(presetOverride)})`, "position": new Vector3(presetOverride.position.x, presetOverride.position.y, presetOverride.position.z), "rotation": new Euler(presetOverride.rotation.x, presetOverride.rotation.y, presetOverride.rotation.z) } : undefined);
        const c = overridingPreset || this.cameraPresets[presetIndex];
        this.context.log("Applying camera preset", c.name, "presetIndex:", presetIndex, "fromWidgetMode:", fromWidgetMode);
        this.context.rendering.applyCameraPreset(c, (presetIndex == defaultPresetIndex && !presetOverride), cameraOverride, fromWidgetMode);
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
            window.alert("Error: Wrong API version on server");
            throw new Error("Wrong API version on server");
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
            this.context.log("Error parsing url fragment:", error);
        }
    }

    private updateUrlFragment() {
        if (!this.selectedCube || !this.selectedParameter) {
            return;
        }
        let query = decodeURIComponent(document.location.search);
        if (query.indexOf(this.urlFragmentStartSymbol) > -1) {
            query = query.substring(0, query.indexOf(this.urlFragmentStartSymbol));
        }
        const hash = this.urlFragmentStartSymbol + [
            this.selectedCube.id.toLowerCase(), 
            this.selectedParameterId.toLowerCase(), 
            this.cubeSelection.getSelectionRangeByDimension(Dimension.Z).toString(true), 
            this.cubeSelection.getSelectionRangeByDimension(Dimension.Y).toString(true), 
            this.cubeSelection.getSelectionRangeByDimension(Dimension.X).toString(true)
        ].join(this.urlFragmentSplitSymbol);
        history.replaceState({}, "", query.length > 1 ? query + hash : "?" + hash);
    }

    private updateAvailableParametersUi() {
        this.htmlParameterSelect.innerHTML = "";

        const groups = new Map<string, string[]>();
        let groupMapper = (p: Parameter) => p.project || "Parameters";

        if (this.cubeTags.includes(CubeTag.CamsEac4Reanalysis)) {
            groupMapper = (p: Parameter) => {
                if (p.longName.toLowerCase().includes("vertically integrated")) return "Vertically Integrated Masses"
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
        const min = this.selectedParameter.getConvertedDataValue(td.statisticalColormapLowerBound);
        const max = this.selectedParameter.getConvertedDataValue(td.statisticalColormapUpperBound);
        if (min == max) {
            return;
        }
        const n = 3 - Math.log10(max - min);
        if (isNaN(n)) {
            return;
        }
        const newSignificance = clamp(Math.round(n), 0, 7);
        if (newSignificance != this.floatDisplaySignificance) {
            // console.log(`New Display significance: ${newSignificance} (previously: ${floatDisplaySignificance})`)
            this.floatDisplaySignificance = newSignificance;
            this.updateColormapRangePlaceholders();
            this.updateHoverInfoUi(false);
        }
        this.context.log(`Updating display significance:${n} ${newSignificance}, observed range (via statistical colormap bounds since min/max might be heavily skewed by outliers): ${td.statisticalColormapLowerBound} - ${td.statisticalColormapUpperBound}, min: ${this.selectedParameter.getConvertedDataValue(td.statisticalColormapLowerBound)}, max: ${this.selectedParameter.getConvertedDataValue(td.statisticalColormapUpperBound)}`);
    }

    convertColormapDataToRGB8(source: number[][]) {
        return this.colormapUi.convertDataToRGB8(source);
    }

    getColormapDataFromName(name: string) {
        return this.colormapUi.getDataFromName(name);
    }

    updateColormapScaleFlip(flipped: boolean) {
        this.colormapUi.updateScaleFlip(flipped);
    }

    updateColormapScaleTexts(minValue: number, maxValue: number) {
        this.colormapUi.updateScaleTexts(minValue, maxValue);
    }

    private selectArbitraryLinearColormap(parameterIndex: number) {
        this.colormapUi.selectArbitraryLinear(parameterIndex);
    }

    deselectColormapInUi() {
        this.colormapUi.deselectInUi();
    }

    selectColormapByName(name: string) {
        return this.colormapUi.selectByName(name);
    }

    selectColormapByData(data: number[][]) {
        return this.colormapUi.selectByData(data);
    }

    private getDisplaySizeBounds(face: CubeFace) {
        let width = this.cubeDimensions.xParameterRangeForFace(face).length();
        let height = this.cubeDimensions.yParameterRangeForFace(face).length();
        const dataAspectRatio = (face == CubeFace.Front || face == CubeFace.Back || face == CubeFace.Top || face == CubeFace.Bottom) ? this.XYdataAspectRatio : 1.0;
        const minDisplaySize = new Vector2(width * Math.pow(0.5, MAX_ZOOM_FACTOR) / dataAspectRatio, height * Math.pow(0.5, MAX_ZOOM_FACTOR));
        let maxDisplaySize = new Vector2();
        if (dataAspectRatio > 1.0) {
            maxDisplaySize = new Vector2(this.roundDownToSparsity(width / dataAspectRatio), this.roundDownToSparsity(height));
        } else {
            maxDisplaySize = new Vector2(this.roundDownToSparsity(width), this.roundDownToSparsity(height * dataAspectRatio));
        }
        return { maxDisplaySize, minDisplaySize };
    }

    private changeZoomOnFace(zoomDelta: number, face: CubeFace, focusUv: Vector2, immediate: boolean = false) {
        if (zoomDelta > 0) {
            this.reconstructZoomFactor(face, true);
        }
        const displaySizeBounds = this.getDisplaySizeBounds(face);
        const newDisplaySize = displaySizeBounds.maxDisplaySize.clone();
        const oldDisplaySize = this.cubeSelection.getDisplaySizeVector2d(face).clone();
        const oldDisplayOffset = this.cubeSelection.getDisplayOffsetVector2d(face).clone();
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
            newCenterPoint = this.currentZoomOldCenterPoint.clone().multiplyScalar(1 - p).add(this.currentZoomNewCenterPoint.clone().multiplyScalar(p));
        }

        // WIP: keep manually chosen aspect ratios; but no way to "leave it"
        // const aspectRatioDifference = 1.0 + oldDisplaySize.x / oldDisplaySize.y - maxDisplaySize.x / maxDisplaySize.y;
        // const aspectRatio = new Vector2(aspectRatioDifference < 1 ? aspectRatioDifference : 1.0, aspectRatioDifference > 1 ? 1.0 / aspectRatioDifference : 1.0);
        // //const f = new Vector2(previousAspectRatio, 1.0);
        // console.log(aspectRatioDifference, aspectRatio);
        // newDisplaySize.multiply(aspectRatio);

        const xOverflowEnabled = this.getXOverflowEnabledForFace(face);

        newDisplaySize.multiplyScalar(zoomFactor);
        // on side faces, only zoom into time
        if (face == CubeFace.Left || face == CubeFace.Right || face == CubeFace.Top || face == CubeFace.Bottom) {
            newDisplaySize.x = oldDisplaySize.x;
        }
        
        this.triggerMaxRangeIndicatorsFromSizeIfNecessary(face, newDisplaySize, displaySizeBounds.maxDisplaySize);
        newDisplaySize.clamp(displaySizeBounds.minDisplaySize, displaySizeBounds.maxDisplaySize);

        const relativeOffset = newDisplaySize.clone().multiplyScalar(0.5);
        const centerPoint = zoomFactorChanged ? newCenterPoint : oldCenterPoint;
        newDisplayOffset.copy(centerPoint).sub(relativeOffset);

        const minimumDisplayOffset = this.getMinimumDisplayOffset(face);
        const maximumDisplayOffset = this.getMaximumDisplayOffset(face, newDisplaySize);

        if (xOverflowEnabled) {
            newDisplayOffset.y = clamp(newDisplayOffset.y, minimumDisplayOffset.y, maximumDisplayOffset.y);
            newDisplayOffset.x = this.normalizeOverflowingXValue(newDisplayOffset.x, face);
        } else {
            newDisplayOffset.clamp(minimumDisplayOffset, maximumDisplayOffset)
        }

        if (immediate) {
            this.cubeSelection.setVectors(face, newDisplaySize, newDisplayOffset);
        } else {
            this.cubeSelection.setVectorsNoRounding(face, newDisplaySize, newDisplayOffset);
            this.interactionFinishFace = face;
            this.interactionFinishDisplaySize = newDisplaySize;
            this.interactionFinishDisplayOffset = newDisplayOffset;
        }
        
        this.triggerMaxRangeIndicatorsFromOffsetIfTouchEdges(face, this.cubeSelection.getDisplayOffsetVector2d(face), this.cubeSelection.getDisplaySizeVector2d(face));
    }

    private triggerMaxRangeIndicatorsFromSizeIfNecessary(face: CubeFace, unclampedNewDisplaySize: Vector2, maxDisplaySize: Vector2) {
        const xOverflowEnabled = this.getXOverflowEnabledForFace(face);
        if (unclampedNewDisplaySize.x == maxDisplaySize.x && !xOverflowEnabled) {
            this.context.rendering.showMaxRangeIndicator(face, Dimension.X, false);
            this.context.rendering.showMaxRangeIndicator(face, Dimension.X, true);
        }
        if (unclampedNewDisplaySize.y == maxDisplaySize.y) {
            this.context.rendering.showMaxRangeIndicator(face, Dimension.Y, false);
            this.context.rendering.showMaxRangeIndicator(face, Dimension.Y, true);
        }
    }

    private triggerMaxRangeIndicatorsFromOffsetIfScrolledOutSignificantly(face: CubeFace, unclampedNewDisplayOffset: Vector2, displaySize: Vector2) {
        const minimumDisplayOffset = this.getMinimumDisplayOffset(face);
        const maximumDisplayOffset = this.getMaximumDisplayOffset(face, displaySize);
        const xOverflowEnabled = this.getXOverflowEnabledForFace(face);
        const xScrolledOutside = xOverflowEnabled ? 0 : Math.max(minimumDisplayOffset.x - unclampedNewDisplayOffset.x, unclampedNewDisplayOffset.x - maximumDisplayOffset.x, 0);
        const yScrolledOutSide = Math.max(minimumDisplayOffset.y - unclampedNewDisplayOffset.y, unclampedNewDisplayOffset.y - maximumDisplayOffset.y, 0);

        // 1/8th of the currently shown cube need to be scrolled to trigger the indicator
        const xScrolledOutsideSignificantly = xScrolledOutside > (displaySize.x / 8.0);
        const yScrolledOutsideSignificantly = yScrolledOutSide > (displaySize.y / 8.0);

        let anyTriggered = false;
        
        if (xScrolledOutsideSignificantly && unclampedNewDisplayOffset.x < minimumDisplayOffset.x && !xOverflowEnabled) {
            this.context.rendering.showMaxRangeIndicator(face, Dimension.X, true);
            anyTriggered = true;
        }
        if (yScrolledOutsideSignificantly && unclampedNewDisplayOffset.y < minimumDisplayOffset.y) {
            this.context.rendering.showMaxRangeIndicator(face, Dimension.Y, true);
            anyTriggered = true;
        }
        if (xScrolledOutsideSignificantly && unclampedNewDisplayOffset.x > maximumDisplayOffset.x && !xOverflowEnabled) {
            this.context.rendering.showMaxRangeIndicator(face, Dimension.X, false);
            anyTriggered = true;
        }
        if (yScrolledOutsideSignificantly && unclampedNewDisplayOffset.y > maximumDisplayOffset.y) {
            this.context.rendering.showMaxRangeIndicator(face, Dimension.Y, false);
            anyTriggered = true;
        }
        return anyTriggered;
    }

    private triggerMaxRangeIndicatorsFromOffsetIfTouchEdges(face: CubeFace, clampedNewDisplayOffset: Vector2, displaySize: Vector2) {
        const minimumDisplayOffset = this.getMinimumDisplayOffset(face);
        const maximumDisplayOffset = this.getMaximumDisplayOffset(face, displaySize);
        const xOverflowEnabled = this.getXOverflowEnabledForFace(face);

        const xMinTouchesEdge = minimumDisplayOffset.x == clampedNewDisplayOffset.x;
        const yMinTouchesEdge = minimumDisplayOffset.y == clampedNewDisplayOffset.y;
        const xMaxTouchesEdge = maximumDisplayOffset.x == clampedNewDisplayOffset.x;
        const yMaxTouchesEdge = maximumDisplayOffset.y == clampedNewDisplayOffset.y;

        if (xMinTouchesEdge && !xOverflowEnabled) {
            this.context.rendering.showMaxRangeIndicator(face, Dimension.X, true);
        }
        if (yMinTouchesEdge) {
            this.context.rendering.showMaxRangeIndicator(face, Dimension.Y, true);
        }
        if (xMaxTouchesEdge && !xOverflowEnabled) {
            this.context.rendering.showMaxRangeIndicator(face, Dimension.X, false);
        }
        if (yMaxTouchesEdge) {
            this.context.rendering.showMaxRangeIndicator(face, Dimension.Y, false);
        }
    }


    reconstructAllZoomFactors() {
        for (let face = 0; face < 3; face++) {
            this.reconstructZoomFactor(face * 2);
        }
    }

    reconstructZoomFactor(face: CubeFace, onlyAssignIfDifferent: boolean = false) {
        const maxDisplaySize = this.getDisplaySizeBounds(face).maxDisplaySize;
        const displaySize = this.cubeSelection.getDisplaySizeVector2d(face).clone().divide(maxDisplaySize);

        const newZoomFactor = clamp(1.0 - Math.log2(Math.min(displaySize.x, displaySize.y)), 1.0, MAX_ZOOM_FACTOR);
        const zoomFactorDifference = Math.abs(newZoomFactor - this.currentZoomFactor[Math.floor(face / 2)]);
        if (!onlyAssignIfDifferent || (zoomFactorDifference > 0.3)) {
            this.currentZoomFactor[Math.floor(face / 2)] = newZoomFactor;
            this.context.log("Reconstructed zoom factor", newZoomFactor, "for face", CubeFace[face]);
        }
    }

    roundToSparsity(value: number) {
        return roundToSparsity(value, this.selectedCubeMetadata.sparsity);
    }

    roundUpToSparsity(value: number) {
        return roundUpToSparsity(value, this.selectedCubeMetadata.sparsity);
    }

    roundDownToSparsity(value: number) {
        return roundDownToSparsity(value, this.selectedCubeMetadata.sparsity);
    }

    getMinimumDisplayOffset(face: CubeFace) {
        const xRange = this.cubeDimensions.xParameterRangeForFace(face);
        const yRange = this.cubeDimensions.yParameterRangeForFace(face);
        return new Vector2(xRange.min, yRange.min);
    }

    getMaximumDisplayOffset(face: CubeFace, displaySize: Vector2) {
        const xRange = this.cubeDimensions.xParameterRangeForFace(face);
        const yRange = this.cubeDimensions.yParameterRangeForFace(face);
        const md = new Vector2(xRange.max - displaySize.x, yRange.max - displaySize.y);
        return md;
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

    getVisibleTiles2d(singleFaceOnly: number = -1) {
        const tiles: Tile2D[] = [];
        for (let face = 0; face < 6; face++) {
            if (singleFaceOnly >= 0 && face != singleFaceOnly) {
                continue;
            }
            const visible = this.context.rendering.faceVisibility[face];
            if (!visible) { // maybe instead prioritize by visibility?
                continue;
            }
            const lod = this.context.rendering.lods2d[face];

            const lodTileSize = TILE_SIZE_2D * Math.pow(2, lod);
            let xValues: number[] = [];

            const width = this.cubeDimensions.totalWidthForFace(face);
            const maxX = Math.ceil(width / lodTileSize) - 1;

            const offset = this.cubeSelection.getDisplayOffsetVector2d(face).clone();
            const size = this.cubeSelection.getDisplaySizeVector2d(face).clone();
            const minVisibleY = Math.floor(offset.y / lodTileSize);
            const maxVisibleY = Math.floor((offset.y + size.y - 1) / lodTileSize);
            const minVisibleX = Math.floor(positiveModulo(offset.x, width) / lodTileSize);
            const maxVisibleX = Math.floor((positiveModulo(offset.x + size.x - 1, width)) / lodTileSize);
            const xOverflown = minVisibleX > maxVisibleX;
            if ((face == CubeFace.Front || face == CubeFace.Back || face == CubeFace.Top || face == CubeFace.Bottom) && (xOverflown)) {
                xValues = range(minVisibleX, maxX).concat(range(0, maxVisibleX))
            } else {
                xValues = range(minVisibleX, maxVisibleX);
            }

            for (let x of xValues) {
                for (let y = minVisibleY; y <= maxVisibleY; y++) {
                    const iv = this.cubeSelection.getGuaranteedSparsityValidIndexValueForFace(face);
                    if (iv % this.selectedCubeMetadata.sparsity != 0) {
                        continue; // bandaid fix for when non-sparsity-rounded index values appear during interaction while animating
                    }
                    tiles.push(new Tile2D(face, iv, lod, x, y, this.selectedCube.id, this.selectedParameterId));
                }
            }
        }
        return tiles;
    }
    
    getVisibleTiles3d() {
        const tiles: Tile3D[] = [];
        const lod = this.context.rendering.lod3d;
        
        // const key = "(indexValue), lodValue, tileX, tileY"
        const lodAdjustedTileSize = TILE_SIZE_3D * Math.pow(2, lod);
        let xValues: number[] = [];

        const xRange = this.cubeDimensions.x.steps;
        const offset = this.cubeSelection.getDisplayOffsetVector3d();
        const size = this.cubeSelection.getDisplaySizeVector3d();
        const maxX = Math.ceil(xRange / lodAdjustedTileSize) - 1;

        const minVisibleZ = Math.floor(offset.z / lodAdjustedTileSize);
        const maxVisibleZ = Math.floor((offset.z + size.z - 1) / lodAdjustedTileSize);        
        const minVisibleY = Math.floor(offset.y / lodAdjustedTileSize);
        const maxVisibleY = Math.floor((offset.y + size.y - 1) / lodAdjustedTileSize);
        const minVisibleX = Math.floor(positiveModulo(offset.x, xRange) / lodAdjustedTileSize);
        const maxVisibleX = Math.floor(positiveModulo(offset.x + size.x - 1, xRange) / lodAdjustedTileSize);

        const xOverflown = minVisibleX > maxVisibleX;

        // console.log("xoverflown", xOverflown, minVisibleX, maxVisibleX, offset.x, size.x, xRange);
        if (xOverflown) {
            xValues = range(minVisibleX, maxX).concat(range(0, maxVisibleX))
        } else {
            xValues = range(minVisibleX, maxVisibleX);
        }

        for (let x of xValues) {
            for (let y = minVisibleY; y <= maxVisibleY; y++) {
                for (let z = minVisibleZ; z <= maxVisibleZ; z++) {
                    tiles.push(new Tile3D(lod, x, y, z, this.selectedCube.id, this.selectedParameterId));
                }
            }
        }

        return tiles;
    }

    async triggerTileDownloads2d(singleFaceOnly: number = -1) {
        for (let face = 0; face < 6; face++) {
            if (singleFaceOnly >= 0 && face != singleFaceOnly) {
                continue;
            }
            const newIndexValue = this.cubeSelection.getGuaranteedSparsityValidIndexValueForFace(face);
            if (this.lastIndexValue[face] != newIndexValue) {
                this.context.tileData.resetTile2dDownloadMapsForFace(face);
                this.lastIndexValue[face] = newIndexValue;
            }
        }
        const visibleTiles = this.getVisibleTiles2d(singleFaceOnly);
        this.context.rendering.visibleTiles2dChanged(visibleTiles); // since it potentially updates TTVs, can influence tileDownloadsTriggered

        const tilesToDownload = visibleTiles.filter(t => !this.context.tileData.isTileDownloadTriggered(t) && this.context.rendering.tileContainedInTileTextureView2d(t));

        if (tilesToDownload.length > 0) {
            this.context.networking.downloadTiles(tilesToDownload);
        }

        if (tilesToDownload.length == 0) {
            this.context.rendering.setAllTilesDownloaded();
        } else {
            this.renderedAfterAllTilesDownloaded = false;
        }
        // this.context.log(`Triggered ${tilesToDownload.length} tile downloads`)

        if (singleFaceOnly >= 0) {
            return;
        }
        const finishedTiles = visibleTiles.filter(t => this.context.tileData.isTileDownloadFinished(t))
        const faces = this.getVisibleFaces();
        for (let face of faces) {
            if (finishedTiles.filter(t => t.face == face).length == visibleTiles.filter(t => t.face == face).length) {
                // exceptional early LoD reveal for when all tiles are already downloaded (also: maybe LoD has not changed but it's okay)
                this.context.rendering.revealLod2dForFace(face);
            }
        }
    }

    async triggerTileDownloads3d(tiles: Tile3D[] | null = null) {
        const visibleTiles = this.getVisibleTiles3d();
        this.context.rendering.visibleTiles3dChanged(visibleTiles); // since it potentially updates TTVs, can influence tileDownloadsTriggered
        
        const tilesToDownload = tiles || visibleTiles.filter(t => !this.context.tileData.isTileDownloadTriggered(t));

        if (tilesToDownload.length > 0) {
            tilesToDownload.forEach(t => this.context.tileData.setTileDownloadTriggered(t));
            this.context.networking.downloadTiles(tilesToDownload);
        }

        if (tilesToDownload.length == 0) {
            this.context.rendering.setAllTilesDownloaded();
        } else {
            this.renderedAfterAllTilesDownloaded = false;
        }
        
        const finishedTiles = visibleTiles.filter(t => this.context.tileData.isTileDownloadFinished(t))
        if (finishedTiles.length == visibleTiles.length) {
            // exceptional LoD refresh for when all tiles are already downloaded (also: maybe LoD has not changed but it's okay)
            this.context.rendering.revealLod3d();
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
        return this.renderedAfterAllTilesDownloaded;
    }

    resetRenderedAfterAllTilesDownloaded() {
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
        this.hideResolutionChangeInfo(); // not sure if best place
    }
    
    private async attemptNextAnimationStep(firstFrame: boolean = false) {
        if (this.nextAnimationStepScheduled) {
            return;
        }
        const lastFrame = this.animationFinishRequested || !this.animationParameters.increaseStep();
        if (!firstFrame) {
            await this.context.rendering.captureRecordingFrame(lastFrame);
        }
        if (lastFrame) {
            this.animationEnabled = false;
            this.stopAnimation();
            return;
        }
        const lastStepTime = performance.now() - this.animationLastStepTime;
        const targetTime = 1.0 / this.animationParameters.getFps() * 1000.0;
        const w = Math.max(0, targetTime - lastStepTime);
        if (w > 0) {
            window.setTimeout(this.nextAnimationStep.bind(this), w);
            this.nextAnimationStepScheduled = true;
        } else {
            this.nextAnimationStep();
        }
        const lastFrameTime = performance.now() - this.animationLastFrameTime;
        // console.log(performance.now(), "last frame time:", lastFrameTime, "last step time", lastStepTime);
        this.animationLastFrameTime = performance.now();
    }

    private nextAnimationStep() {
        this.nextAnimationStepScheduled = false;
        this.animationLastStepTime = performance.now();
        const range = this.animationParameters.getAnimationRangeFromStep();
        this.cubeSelection.setRange(this.animationParameters.getDimension(), range.min, range.max);
        this.cubeSelection.updateSelectionRelevantUi(true, true, [ this.animationParameters.getDimension() ]);
        this.context.rendering.updateVisibilityAndLods();
        if (this.isMouseHoveringOverCube) {
            this.updateHoverInfo();
        }
    }

    getColormapMinMaxValuePrecision() {
        if (this.cubeTags.includes(CubeTag.SpectralIndices)) {
            return 1;
        }
        if (this.cubeTags.includes(CubeTag.Era5SpecificHumidity) && !this.selectedParameter.isAnomalyParameter()) {
            return 5;
        }
        return Infinity;
    }

    updateRequestProgressFromWidget(progress: number[], isReliableProgressForTiming: boolean = false) {
        this.requestProgressTimingEnabled = isReliableProgressForTiming;
        const done = progress[0];
        const total = progress[1];
        if (this.requestProgressTimingEnabled) {
            if (done == 0) {
                this.requestProgressStart = performance.now();
            }
            this.requestProgressLastUpdate = performance.now();
        }
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
            svg = svg.replace("qrcode.png", "");
        } else {
            // force lexcube.org URL for QR codes if run on localhost; assuming the data set exists there :)
            const qrUrl = window.location.hostname == "localhost" ? `https://www.lexcube.org/?!${document.URL.substring(document.URL.indexOf("!") + 1)}` : document.URL;
            const qr = await QRCode.toDataURL(qrUrl, { color: { dark: "#000", light: "#ffffff00" } });
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
            return await (await fetch("paper-cube-template-v4.svg")).text();
        }
    }

    showResolutionChangeInfo(lod: number) {
        const isNewLodAlreadyAllocated = this.context.tileData.isTexture3dAllocated(lod);
        const resolutionText = `${Math.round(100 * Math.pow(0.5, lod))}% data resolution`;
        const allocatedSoFar = this.context.tileData.getActual3dStorageSizeOfLodInBytes();
        const nowAllocating = this.context.tileData.getTheoretical3dStorageSizeOfLodInBytes(lod);
        const totalBytesCpu = (allocatedSoFar.cpuSideBytes + (isNewLodAlreadyAllocated ? 0 : nowAllocating.cpuSideBytes)) / (1024 * 1024);
        const totalBytesGpu = (allocatedSoFar.gpuSideBytes + (isNewLodAlreadyAllocated ? 0 : nowAllocating.gpuSideBytes)) / (1024 * 1024);
        this.htmlVolumeVizStatsRow.innerText = `Shown: ${resolutionText} - RAM: ${totalBytesCpu.toFixed(0)} MB / VRAM: ${totalBytesGpu.toFixed(0)} MB (${this.context.tileData.get3dStorageType()})`;
        if (!isNewLodAlreadyAllocated) {
            // this.resolutionChangeHeadingDiv.innerText = `Allocating 3D vo`;
            // this.resolutionChangeLabelDiv.innerText = `Allocating ${newMBallocated.toFixed(0)} MB...`;
            // this.resolutionChangePopupDiv.style.display = "flex";
        }
    }

    hideResolutionChangeInfo() {
        this.resolutionChangePopupDiv.style.display = "none";
    }

    showConnectionLostAlert() {
        this.connectionLostMessageVisible = true;
        this.updateStatusMessage();
    }
    
    hideConnectionLostAlert() {
        this.connectionLostMessageVisible = false;
        this.updateStatusMessage();
    }

    private setAnimationUseSelectedRangeOnly() {
        this.animationParameters.setUseSelectedRange(this.animationUi.isSelectedRangeOnlyChecked());
        this.updateAnimationSliders();
    }

    updateAnimationSelectedRangeOnlyLabel() {
        if (this.animationEnabled) {
            return;
        }
        const d = this.animationParameters.getDimension();
        const range = this.cubeSelection.getSelectionRangeByDimension(d);
        this.animationParameters.updateSelectedRange(range);
        if (this.animationUi.isSelectedRangeOnlyChecked()) {
            this.updateAnimationSliders();
        }
        this.animationUi.updateSelectedRangeOnlyLabel();
    }

    private updateAnimationDimension(dimension: Dimension) {
        this.animationEnabled = false;
        this.stopAnimation();
        this.animationUi.setSelectedRangeOnlyChecked(false);
        this.animationParameters.updateDimension(dimension, this.cubeDimensions);
        this.updateAnimationSelectedRangeOnlyLabel();
        this.updateAnimationSliders();
    }

    private updateAnimationDimensionSelectLabels() {
        this.animationUi.updateDimensionSelectLabels();
    }

    isCurrentCubeZeroIndexGreenwich() {
        return this.cubeTags.includes(CubeTag.LongitudeZeroIndexIsGreenwich);
    }

    updateControlsCamera(camera: Camera) {
        this.orbitControls.camera = camera;
        this.orbitControls.update();
    }

    updateControls(reconstructTarget: boolean = false) {
        this.orbitControls.update(reconstructTarget);
    }

    getMaxLod3d() {
        const requestedMaxLod = this.selectedCubeMetadata.max_lod_3d;
        if (requestedMaxLod === undefined || requestedMaxLod === null || isNaN(requestedMaxLod)) {
            return 0;
        }
        return Math.max(0, Math.min(requestedMaxLod, MAXIMUM_SUPPORTED_LOD));
    }

    getMaxLod2d() {
        let requestedMaxLod = this.selectedCubeMetadata.max_lod_2d;
        if (requestedMaxLod === undefined || requestedMaxLod === null || isNaN(requestedMaxLod)) {
            const largestDim = this.cubeDimensions.totalSize().clone().toArray().reduce((a, b) => Math.max(a, b), 0);
            const calculatedMaxLod = Math.max(Math.floor(Math.log2(largestDim / TILE_SIZE_2D)), 0);
            this.selectedCubeMetadata.max_lod_2d = calculatedMaxLod;
            requestedMaxLod = calculatedMaxLod;
            console.warn("Cube metadata missing max_lod_2d, setting to", requestedMaxLod, "based on largest dimension size", largestDim);
        }
        return Math.max(0, Math.min(requestedMaxLod, MAXIMUM_SUPPORTED_LOD));
    }

    
    receiveEventData(metadata: any, buffer: ArrayBuffer) {
        console.log("Received event data with metadata", metadata, "and buffer of byte length", buffer.byteLength);
        // buffer has N events, each event has the following structure:
            // # start_index (in time) uint16
            // # end_index (in time)uint16
            // # min_x_index uint16
            // # max_x_index uint16
            // # min_y_index uint16
            // # max_y_index uint16
            // # n_observations uint32
        const eventSize = 2 + 2 + 2 + 2 + 2 + 2 + 4 + 4; // in bytes
        const nEvents = buffer.byteLength / eventSize;
        const dataView = new DataView(buffer);
        const events: ExtremeEvent[] = [];
        for (let i = 0; i < nEvents; i++) {
            if (i > 100) {
                break;
            }
            const event = ExtremeEvent.fromDataView(i + 1, dataView, i * eventSize);
            events.push(event);
        }
        console.log("Received", events.length, "events", events);
        this.htmlVolumeVizEventTableBody.innerHTML = "";
        let html = ``;
        for (let event of events) {
            html += event.toTableRow(this.cubeDimensions);
        }
        this.htmlVolumeVizEventTableBody.innerHTML = html;
        this.htmlVolumeVizEventExploreLink.textContent = `Explore ${events.length} events >`;
    }

}

class ExtremeEvent {
    constructor(public eventIndex: number, public startIndex: number, public endIndex: number, public minXIndex: number, public maxXIndex: number, public minYIndex: number, public maxYIndex: number, public areaKm2: number, public nObservations: number) {}

    static fromDataView(eventIndex: number, dataView: DataView, offset: number): ExtremeEvent {
        const startIndex = dataView.getUint16(offset, true);
        const endIndex = dataView.getUint16(offset + 2, true);
        const minXIndex = dataView.getUint16(offset + 4, true);
        const maxXIndex = dataView.getUint16(offset + 6, true);
        const minYIndex = dataView.getUint16(offset + 8, true);
        const maxYIndex = dataView.getUint16(offset + 10, true);
        const areaKm2 = dataView.getUint32(offset + 12, true);
        const nObservations = dataView.getUint32(offset + 16, true);
        return new ExtremeEvent(eventIndex, startIndex, endIndex, minXIndex, maxXIndex, minYIndex, maxYIndex, areaKm2, nObservations);
    }

    toTableRow(cubeDimensions: CubeDimensions): string {
        const firstTimeIndex = cubeDimensions.z.getIndexString(this.startIndex);
        const lastTimeIndex = cubeDimensions.z.getIndexString(this.endIndex);
        const durationString = cubeDimensions.z.getDifferenceString(this.endIndex - this.startIndex + 1).differenceString;
        // const timeRangeString = firstTimeIndex == lastTimeIndex ? firstTimeIndex : `${firstTimeIndex} /<br>${lastTimeIndex}`;
        const timeRangeString = `${firstTimeIndex}<br>+ ca. ${durationString}`;
        const spaceCoverageString = `${(this.areaKm2 / 1000).toFixed(0)}k km²<br>(${this.maxXIndex - this.minXIndex + 1}×${this.maxYIndex - this.minYIndex + 1})`;
        const centerXYString = `${cubeDimensions.x.getIndexString(Math.floor((this.minXIndex + this.maxXIndex) / 2))} / ${cubeDimensions.y.getIndexString(Math.floor((this.minYIndex + this.maxYIndex) / 2))}`;  
        return `<tr><td>#${this.eventIndex}</td><td>${this.nObservations} obs</td><td>${timeRangeString}</td><td>${spaceCoverageString}</td><td>${centerXYString}</td></tr>`;
    }
}

export { CubeInteraction }
// Re-export from core modules for backward compatibility
export { CubeDimension, CubeDimensions, CubeDimensionType, CubeTag, GeospatialContext, GeospatialContextCorrection, GeospatialRange, ParameterRange } from './core/dimensions';
export { Parameter, ParameterAttributionMetadata, ParameterColormapMetadata } from './core/parameters';
export { CubeSelection, SelectionState } from './core/selection';
export { AnimationParameters } from './core/animation';