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

import { Color, DataArrayTexture, Texture, RedFormat, FloatType, LinearFilter, NearestFilter, ClampToEdgeWrapping } from 'three'

import { COLORMAP_STEPS, CubeFace, Dimension, LOSSLESS_TILE_MAGIC_NUMBER, NAN_REPLACEMENT_VALUE, NAN_TILE_MAGIC_NUMBER, NOT_LOADED_REPLACEMENT_VALUE, TILE_FORMAT_MAGIC_BYTES, TILE_SIZE, TILE_VERSION } from './constants';
import { CubeClientContext } from './client';

import { Blosc, ZFP, LZ4 } from 'numcodecs';

class Tile {
    static fromResponseData(metadata: any): Tile[] {
        const tiles = [];
        for (let xy of metadata.xys) {
            tiles.push(new Tile(metadata.face, metadata.indexValue, metadata.lod, xy[0], xy[1], metadata.datasetId, metadata.parameter))
        }
        return tiles;
    }

    static fromHashKey(context: CubeClientContext, key: string): Tile {
        const s = key.split("_");
        return new Tile(Number(s[0]), Number(s[1]), Number(s[2]), Number(s[3]), Number(s[4]), context.interaction.selectedCube.id, context.interaction.selectedParameterId);
    }

    constructor(face: CubeFace, indexValue: number, lod: number, tileX: number, tileY: number, cubeId: string, parameter: string) {
        this.cubeId = cubeId;
        this.parameter = parameter ;
        this.face = face;
        this.indexValue = indexValue;
        this.lod = lod;
        this.x = tileX;
        this.y = tileY;
    }

    toString() {
        return `${CubeFace[this.face]} LoD: ${this.lod} TileX: ${this.x} TileY: ${this.y}`;
    }

    indexDimension() {
        return (this.face <= 1 ? Dimension.Z : (this.face <= 3 ? Dimension.Y : Dimension.X));
    }

    getRequestData() {
        return {
            face: this.face,
            datasetId: this.cubeId,
            parameter: this.parameter,
            indexDimension: `by_${Dimension[this.indexDimension()].toLowerCase()}`,
            indexValue: this.indexValue,
            lod: this.lod,
            tileX: this.x,
            tileY: this.y
        }
    }
    
    getRequestDataWithMultipleXYs(xys: number[][]) {
        return {
            face: this.face,
            datasetId: this.cubeId,
            parameter: this.parameter,
            indexDimension: `by_${Dimension[this.indexDimension()].toLowerCase()}`,
            indexValue: this.indexValue,
            lod: this.lod,
            xys: xys,
        }
    }
    
    getHashKey() {
        return `${this.face}_${this.indexValue}_${this.lod}_${this.x}_${this.y}_${this.cubeId}_${this.parameter}`;
    }

    cubeId: string;
    parameter: string;
    face: CubeFace;
    indexValue: number;
    lod: number;
    x: number;
    y: number;
}

class ColormapEntry {
    constructor(value: number, color: Color) {
        this.value = value;
        this.color = color;
    }

    value: number;
    color: Color;
}

class TileData {
    // from https://en.wikipedia.org/wiki/Algorithms_for_calculating_variance Welford's online algorithm
    private observedValuesCount = 0;
    private observedValuesMean = 0;
    private observedValuesVariance = 0;
    statisticalColormapLowerBound = 0;
    statisticalColormapUpperBound = 0;
    
    private linearTextureFilteringEnabled;

    observedMinValue = Infinity;
    observedMaxValue = -Infinity;

    private lastObservedMinValue = 0;
    private lastObservedMaxValue = 0;
    
    private currentColormap: Array<ColormapEntry> = [];    
    private fastColormap: Uint8Array = new Uint8Array(COLORMAP_STEPS * 4);    
    private colorsNotFound = 0;
    colormapFlipped = false;
    colormapUseStandardDeviation = true;
    colormapMinValueOverride: number | undefined;
    colormapMaxValueOverride: number | undefined;
    symmetricalColormapAroundZero = false;
    
    private tileStoragesColor!: Uint8Array[][];
    private tileStoragesFloat!: Float32Array[][];
    
    private tilesDownloadFinished = new Array<Map<string, boolean>>();
    private tilesDownloadTriggered = new Array<Map<string, boolean>>(); 
    tileDownloadsTriggered: number = 0;
    tileDownloadsFinished: number = 0;
    tileDownloadsFailed: number = 0;
    tileDecodesFailed: number = 0;
    
    // private compressor = Blosc.fromConfig({ id: Blosc.codecId, clevel: 5 , cname: "lz4", shuffle: 1 });
    private tileCompressorDefault = ZFP.fromConfig({ id: ZFP.codecId });
    private tileCompressorLossless = Blosc.fromConfig({ id: Blosc.codecId, cname: "lz4", shuffle: 1 });
    private nanMaskCompressor = LZ4.fromConfig({ id: LZ4.codecId });
    private context: CubeClientContext;
    private colormapMinValue: number = 0;
    private colormapMaxValue: number = 0;

    maxCompressionErrors = new Map<string, number>();

    private storagesAllocated!: Set<string>;
    private totalBytesAllocated: number = 0;
    ignoreStatisticalColormapBounds: boolean = false;

    constructor(context: CubeClientContext) {
        this.context = context;
        this.linearTextureFilteringEnabled = this.context.linearTextureFilteringEnabled;
    }
    

    private updateStatisticalMeasures(tileMin: number, tileMax: number, tileMean: number, tileVariance: number) {
        if (isNaN(tileMin)) {
            return;
        }
        if (this.observedMinValue > tileMin) {
            this.observedMinValue = tileMin;
            this.context.interaction.updateDisplaySignificance();
        }
        if (this.observedMaxValue < tileMax) {
            this.observedMaxValue = tileMax;
            this.context.interaction.updateDisplaySignificance();
        }
        this.observedValuesCount += 1;
        const meanDelta = tileMean - this.observedValuesMean;
        this.observedValuesMean += meanDelta / this.observedValuesCount;
        const varianceDelta = tileVariance - this.observedValuesVariance;
        this.observedValuesVariance += varianceDelta / this.observedValuesCount;
    }

    private updateStatisticalColormapBounds() {
        const standardDeviation = Math.sqrt(this.observedValuesVariance);
        this.statisticalColormapLowerBound = Math.max(this.observedValuesMean - (2.5 * standardDeviation), this.observedMinValue);
        this.statisticalColormapUpperBound = Math.min(this.observedValuesMean + (2.5 * standardDeviation), this.observedMaxValue);
    }

    async receiveTile(tile: Tile, data: ArrayBuffer) {
        if (tile.cubeId != this.context.interaction.selectedCube.id || tile.parameter != this.context.interaction.selectedParameterId) {
            this.context.log("Received outdated tile (cube and/or parameter has changed)")
            return;
        }
        if (tile.indexValue != this.context.interaction.cubeSelection.getIndexValueForFace(tile.face)) {
            this.context.log("Receive outdated tile (index value has changed)");
            this.context.tileData.addTileDownloadsFinished(1);
            return;
        }
        this.allocateTexture(tile.face, tile.lod);
        
        const magic_bytes = new Uint8Array(data, 0, 4);
        if (TILE_FORMAT_MAGIC_BYTES !== String.fromCharCode(...magic_bytes)) {
            return console.error("Received tile has invalid magic bytes")
        }
        const tile_version = new Uint32Array(data, 4, 1)[0];
        if (tile_version !== TILE_VERSION) {
            return console.error("Received tile has invalid tile version:", tile_version, "Expected:", TILE_VERSION)
        }
        const maxErrorOrMagicNumber = new Float64Array(data, 16, 1)[0];
        if (maxErrorOrMagicNumber == NAN_TILE_MAGIC_NUMBER) {
            this.putNaNTileInStorage(tile);
        } else {
            const resampleResolution = new Uint32Array(data, 8, 1)[0];

            const nanMaskHeaderLength = new Uint32Array(data, 12, 1)[0];
            const tileMin = new Float64Array(data, 24, 1)[0];
            const tileMax = new Float64Array(data, 32, 1)[0];
            const tileMean = new Float64Array(data, 40, 1)[0];
            const tileVariance = new Float64Array(data, 48, 1)[0];
            const nanMaskHeaderBytes = new Uint8Array(data, 56, nanMaskHeaderLength);
            const tileDataBytes = new Uint8Array(data, 56 + nanMaskHeaderLength);

            this.updateStatisticalMeasures(tileMin, tileMax, tileMean, tileVariance);

            const lossless_tile = maxErrorOrMagicNumber == LOSSLESS_TILE_MAGIC_NUMBER;
            this.maxCompressionErrors.set(tile.getHashKey(), lossless_tile ? 0 : maxErrorOrMagicNumber);

            try {
                if (lossless_tile) {
                    const tileData = await this.tileCompressorLossless.decode(tileDataBytes);
                    if (resampleResolution > 1) {
                        this.putResampledTileInStorage(tile, tileData.buffer, undefined, resampleResolution, true);
                    } else {
                        this.putTileInStorage(tile, tileData.buffer, undefined, true);
                    }
                } else {
                    const result = await Promise.all([this.nanMaskCompressor.decode(nanMaskHeaderBytes), this.tileCompressorDefault.decode(tileDataBytes)]);
                    const nanMaskSource = result[0];
                    const tileData = result[1];
                    if (resampleResolution > 1) {
                        this.putResampledTileInStorage(tile, tileData.buffer, nanMaskSource.buffer, resampleResolution);
                    } else {
                        this.putTileInStorage(tile, tileData.buffer, nanMaskSource.buffer);
                    }
                }
            } catch (error) {
                this.tilesDownloadTriggered[tile.face].delete(tile.getHashKey());
                this.tileDecodesFailed += 1;
                this.updateStatusMessage();
                console.error(`Tile (${CubeFace[tile.face]}) at ${tile.indexValue} with LoD ${tile.lod} and x: ${tile.x} y: ${tile.y} failed to decode:`, error);
                return;
            };
        }
        
        this.updateStatisticalColormapBounds();
        this.colormapTile(tile);

        this.context.tileData.addTileDownloadsFinished(1);
        this.tilesDownloadFinished[tile.face].set(tile.getHashKey(), true);
        if (this.tilesDownloadTriggered[tile.face].size == this.tilesDownloadFinished[tile.face].size) {
            this.context.rendering.revealLodForFace(tile.face);
        }
        const lastDownload = this.tileDownloadsFinished + this.tileDownloadsFailed == this.tileDownloadsTriggered;
        if (lastDownload) {
            this.context.rendering.setAllTilesDownloaded();
            // this.context.rendering.showData();
        }
        if (tile.lod == this.context.rendering.getCurrentlyShownLodForFace(tile.face)) {
            this.context.rendering.showDataForFace(tile.face);
        }
        if (lastDownload || this.context.widgetMode) {
            if (this.lastObservedMaxValue == this.observedMaxValue && this.lastObservedMinValue == this.observedMinValue) {
                return;
            }
            this.lastObservedMaxValue = this.observedMaxValue;
            this.lastObservedMinValue = this.observedMinValue;
            this.context.interaction.updateColormapRangeUi();
            this.colormapHasChanged(true, false);
        }
    }

    allTileDownloadsFinished() {
        return this.context.interaction.fullyLoaded && this.tileDownloadsFinished + this.tileDownloadsFailed == this.tileDownloadsTriggered && this.context.rendering.dataShown();
    }

    private putNaNTileInStorage(tile: Tile) {
        let xTiles = this.context.interaction.cubeDimensions.xTilesForFace(tile.face, tile.lod);

        const tileIndex = tile.x + tile.y * xTiles;
        const startIndex = tileIndex * TILE_SIZE * TILE_SIZE;
        const endIndex = (tileIndex + 1) * TILE_SIZE * TILE_SIZE;

        for (let index = startIndex, i = 0; index < endIndex; index++, i++) {
            this.tileStoragesFloat[tile.face][tile.lod][index] = NAN_REPLACEMENT_VALUE;
        }
    }

    patchTileValues(tile: Tile, values: Float32Array | Float64Array, nanMask: ArrayBuffer | undefined, resampleResolution: number, replaceRealNans: boolean) {
        let anyNanToDisableLinearTextureFiltering = false;
        if (replaceRealNans) {
            for (let i = 0; i < values.length; i++) {
                if (isNaN(values[i])) {
                    values[i] = NAN_REPLACEMENT_VALUE;
                }
            }
            if (this.linearTextureFilteringEnabled) {
                anyNanToDisableLinearTextureFiltering = anyNanToDisableLinearTextureFiltering || values.some(v => isNaN(v));
            }
        }
        if (nanMask) {
            const nanValues = new Float32Array(nanMask);
            for (let i = 0; i < nanValues.length; i++) {
                if (nanValues[i] != 0) {
                    values[i] = NAN_REPLACEMENT_VALUE;
                }
            }
            if (this.linearTextureFilteringEnabled) {
                anyNanToDisableLinearTextureFiltering = anyNanToDisableLinearTextureFiltering || nanValues.some(v => v != 0);
            }
        }
        
        const overflowing = this.applyOverflowingTileFix(tile, values, resampleResolution);

        if (anyNanToDisableLinearTextureFiltering && this.linearTextureFilteringEnabled && !overflowing) { // overflow tiles always contain NaN, hence we ignore them
            this.disableLinearTextureFiltering();
        }
    }
    
    private applyOverflowingTileFix(tile: Tile, values: Float32Array | Float64Array, resampleResolution: number = 1) {
        const overflowInfo = this.context.interaction.cubeDimensions.getOverflowEdgeTileInfo(tile);
        if (!overflowInfo.overflowing) {
            return;
        }
        const pixelFillAmount = (Math.pow(2, tile.lod) + 3) * resampleResolution;
        const resampleFactor = 1 / resampleResolution;
        if (resampleFactor != 1) {
            if (overflowInfo.overflowingX) {
                overflowInfo.xCutoff = Math.floor(overflowInfo.xCutoff * resampleFactor);
            }
            if (overflowInfo.overflowingY) {
                overflowInfo.yCutoff = Math.floor(overflowInfo.yCutoff * resampleFactor);
            }
        }

        // fill right side with previous column values
        if (overflowInfo.overflowingX) {
            const xMin = overflowInfo.xCutoff;
            for (let y = 0; y < Math.min(overflowInfo.yCutoff + pixelFillAmount, TILE_SIZE); y++) {
                const value = values[xMin - 1 + y * TILE_SIZE];
                values.set(Array(pixelFillAmount).fill(value), xMin + y * TILE_SIZE);
            }
        }

        if (overflowInfo.overflowingY) {
            // fill bottom (and diagonal bottom right) side with previous row values
            const yRowToCopy = overflowInfo.yCutoff - 1;
            const copiedRow = values.slice(yRowToCopy * TILE_SIZE, yRowToCopy * TILE_SIZE + Math.min(overflowInfo.xCutoff + pixelFillAmount, TILE_SIZE));
            for (let y = overflowInfo.yCutoff; y < Math.min(overflowInfo.yCutoff + pixelFillAmount, TILE_SIZE); y++) {
                values.set(copiedRow, y * TILE_SIZE);
            }
        }
        return overflowInfo.overflowing;
    }

    private putResampledTileInStorage(tile: Tile, data: ArrayBuffer, nanMask: ArrayBuffer | undefined, resampleResolution: number, replaceRealNans: boolean = false) {
        const seemsLikeFloat64 = data.byteLength == (TILE_SIZE * TILE_SIZE * 8);
        let values = seemsLikeFloat64 ? new Float64Array(data) : new Float32Array(data);
        // console.log(`Putting tile in storage: ${tile}`);
        if (values.length != TILE_SIZE * TILE_SIZE) {
            console.warn(`Badly sized value array passed to putTile (${values.length} instead of ${TILE_SIZE * TILE_SIZE})`)
        }
        let xTiles = this.context.interaction.cubeDimensions.xTilesForFace(tile.face, tile.lod);

        this.patchTileValues(tile, values, nanMask, resampleResolution, replaceRealNans);

        const tileIndex = tile.x + tile.y * xTiles;
        const startIndex = tileIndex * TILE_SIZE * TILE_SIZE;
        const endIndex = (tileIndex + 1) * TILE_SIZE * TILE_SIZE;

        // Adjust for the fact that the resample resolution and the tile size may not match.
        // In that case, a tile may start with a block of less than resampleResolution rows and/or columns,
        // since part of that block was already in the previous adjacent tile
        const xPixelOffset = (tile.x * TILE_SIZE) % resampleResolution;
        const yPixelOffset = (tile.y * TILE_SIZE) % resampleResolution;

        for (let storageIndex = startIndex, i = 0; storageIndex < endIndex; storageIndex++, i++) {
            const pixelX = i % TILE_SIZE;
            const pixelY = Math.floor(i / TILE_SIZE);
            const accessX = Math.floor((pixelX + xPixelOffset) / resampleResolution);
            const accessY = Math.floor((pixelY + yPixelOffset) / resampleResolution);
            const accessIndex = accessX + accessY * TILE_SIZE;
            this.tileStoragesFloat[tile.face][tile.lod][storageIndex] = values[accessIndex];
        }
    }
    
    private putTileInStorage(tile: Tile, data: ArrayBuffer, nanMask: ArrayBuffer | undefined, replaceRealNans: boolean = false) {
        const seemsLikeFloat64 = data.byteLength == (TILE_SIZE * TILE_SIZE * 8);
        let values = seemsLikeFloat64 ? new Float64Array(data) : new Float32Array(data);
        // console.log(`Putting tile in storage: ${tile}`);
        if (values.length != TILE_SIZE * TILE_SIZE) {
            console.warn(`Badly sized value array passed to putTile (${values.length} instead of ${TILE_SIZE * TILE_SIZE})`)
        }
        let xTiles = this.context.interaction.cubeDimensions.xTilesForFace(tile.face, tile.lod);

        const tileIndex = tile.x + tile.y * xTiles;
        const startIndex = tileIndex * TILE_SIZE * TILE_SIZE;

        this.patchTileValues(tile, values, nanMask, 1, replaceRealNans);

        this.tileStoragesFloat[tile.face][tile.lod].set(values, startIndex);
    }
    
    colormapTile(tile: Tile) {
        // let xTiles = this.context.interaction.selectedCubeDimensions.xTilesForFace(tile.face, tile.lod);
    
        // const tileIndex = tile.x + tile.y * xTiles;
        // const startIndex = tileIndex * TILE_SIZE * TILE_SIZE;
        // const endIndex = (tileIndex + 1) * TILE_SIZE * TILE_SIZE;
    
        // for (let index = startIndex, i = 0; index < endIndex; index++, i++) {
        //     const v = this.tileStoragesFloat[tile.face][tile.lod][index];
        //     const b = index * 4;
        //     const col = this.colormap(v);
        //     this.tileStoragesColor[tile.face][tile.lod].set(col, b);
        // }
        this.context.rendering.cube.material[tile.face].uniforms[`tilesLod${tile.lod}`].value.needsUpdate = true;
        this.context.rendering.requestRender();
    }

    colormapHasChanged(optionsChanged: boolean, colormapChanged: boolean) {
        if (optionsChanged) {
            let minValue = this.observedMinValue;
            let maxValue = this.observedMaxValue;
            let changeScaleTexts = true;
            if (minValue == Infinity && maxValue == -Infinity) {
                changeScaleTexts = false;
            } 
            if (this.colormapUseStandardDeviation && !this.ignoreStatisticalColormapBounds) {
                minValue = this.statisticalColormapLowerBound;
                maxValue = this.statisticalColormapUpperBound;
            }
            minValue = this.colormapMinValueOverride !== undefined ? this.colormapMinValueOverride : minValue; 
            maxValue = this.colormapMaxValueOverride !== undefined ? this.colormapMaxValueOverride : maxValue;
    
            if (this.symmetricalColormapAroundZero) {
                const largerValue = Math.max(Math.abs(minValue), Math.abs(maxValue));
                minValue = -largerValue;
                maxValue = largerValue;    
            }

            this.colormapMinValue = minValue;
            this.colormapMaxValue = maxValue;
            const targetPrecision = this.context.interaction.getColormapMinMaxValuePrecision();
            if (targetPrecision < Infinity) {
                this.colormapMaxValue = Math.round(this.colormapMaxValue * 10**targetPrecision) / 10**targetPrecision;
                this.colormapMinValue = Math.round(this.colormapMinValue * 10**targetPrecision) / 10**targetPrecision;
            }
            this.context.log("Colormap options changed", this.colormapMinValue, this.colormapMaxValue, this.colormapFlipped)
            this.context.rendering.updateColormapOptions(this.colormapMinValue, this.colormapMaxValue, this.colormapFlipped);
            if (changeScaleTexts) {
                this.context.interaction.updateColormapScaleTexts(this.colormapMinValue, this.colormapMaxValue);
            }
        }

        if (colormapChanged) {
            this.context.log("Colormap texture changed")
            this.updateFastColormap();
            this.context.rendering.updateColormapTexture(this.fastColormap);
        }
        if (optionsChanged || colormapChanged) {
            this.context.rendering.requestRender();
        }
    }

    selectedColormapName: string = "";
    
    selectColormapByName(name: string) {
        try {
            const colormapData = this.context.interaction.getColormapDataFromName(name);
            this.selectColormapByData(colormapData);
            this.selectedColormapName = name;
            return true;
        } catch (error) {
            this.context.log("Failed to select colormap", name, error);
            return false;
        }
    }

    selectColormapByData(data: Array<Array<number>>) {
        this.selectedColormapName = "Custom Colormap";

        this.currentColormap.splice(0, this.currentColormap.length);

        for (let i = 0; i < data.length; i++) {
            const p = i / (data.length - 1);
            const c = data[i];
            this.currentColormap.push(new ColormapEntry(p, new Color(c[0], c[1], c[2])));
        }

        this.colormapHasChanged(false, true);
        return true;
    }

    private getColorFromColormap(p: number) {
        const colors = this.currentColormap;

        for (let i = 0; i < colors.length - 1; i++) {
            const previous = colors[i];
            const next = colors[i + 1];
            
            if (previous.value <= p && next.value >= p) {
                return new Color().lerpColors(previous.color, next.color, (p - previous.value) / (next.value - previous.value))
            }
        }
        // console.error(`Color map did not find color. Value: ${v} Minvalue: ${minValue} Maxvalue: ${maxValue} colormapMinValueOverride ${this.colormapMinValueOverride} colormapMaxValueOverride ${this.colormapMaxValueOverride}`);
        this.colorsNotFound++;
        return new Color("white");
    }

    private updateFastColormap() {
        for (let i = 0; i <= COLORMAP_STEPS; i++) {
            const col = this.getColorFromColormap(i * 1.0 / COLORMAP_STEPS);
            this.fastColormap[i * 4 + 0] = col.r;
            this.fastColormap[i * 4 + 1] = col.g;
            this.fastColormap[i * 4 + 2] = col.b;
            this.fastColormap[i * 4 + 3] = 255;
        }
    }

    allocateTileStorages(cubeChanged: boolean = false) {
        if (!cubeChanged && this.tileStoragesFloat && this.tileStoragesFloat.length > 1) {
            for (let faceStorage of this.tileStoragesFloat) {
                for (let lodStorage of faceStorage) {
                    lodStorage.fill(NOT_LOADED_REPLACEMENT_VALUE);
                }
            }
            for (let face = 0; face < 6; face++) {
                const material = this.context.rendering.cube.material[face];
                for (let lod = 0; lod <= this.context.interaction.selectedCubeMetadata.max_lod; lod++) {
                    material.uniforms[`tilesLod${lod}`].value.needsUpdate = true;
                }
            }
            this.context.log("Recycled existing textures and float32 arrays");
            return;
        }
        this.tileStoragesFloat = [];
        for (let face = 0; face < 6; face++) {
            this.tileStoragesFloat.push([]);
            for (let lod = 0; lod <= this.context.interaction.selectedCubeMetadata.max_lod; lod++) {
                this.tileStoragesFloat[face].push(new Float32Array(0));
            }
        }
        this.storagesAllocated = new Set<string>();
        this.totalBytesAllocated = 0;
        this.context.log(`Reset tile storages`);
    }

    private allocateTexture(face: CubeFace, lod: number) {
        const key = `${face}-${lod}`
        if (this.storagesAllocated.has(key)) {
            return;
        }
        this.storagesAllocated.add(key);
        
        const material = this.context.rendering.cube.material[face];
        if (material.uniforms[`tilesLod${lod}`].value) {
            (material.uniforms[`tilesLod${lod}`].value as Texture).dispose();
        }
        const totalTiles = this.context.interaction.cubeDimensions.totalTilesForFace(face, lod);
        const totalValues = (TILE_SIZE * TILE_SIZE) * totalTiles;
        const totalBytes = 4 * totalValues;
        this.tileStoragesFloat[face][lod] = new Float32Array(totalValues);
        this.tileStoragesFloat[face][lod].fill(NOT_LOADED_REPLACEMENT_VALUE);
        
        const texture = new DataArrayTexture(this.tileStoragesFloat[face][lod], TILE_SIZE, TILE_SIZE, totalTiles);
        // texture.generateMipmaps = true;
        texture.magFilter = NearestFilter;
        texture.minFilter = this.linearTextureFilteringEnabled ? LinearFilter : NearestFilter;
        this.context.log("Creating texture with minFilter: ", texture.minFilter == NearestFilter ? "NearestFilter" : "LinearFilter")
        texture.wrapS = ClampToEdgeWrapping;
        texture.wrapT = ClampToEdgeWrapping;
        // texture.needsUpdate = true;
        texture.format = RedFormat;
        texture.type = FloatType;
        material.uniforms[`tilesLod${lod}`].value = texture;
        // console.log(`Cube side ${CubeFace[face]}, LoD ${lod}, TotalTiles ${totalTiles}, allocating ${totalBytes / (1024)} KB`)
        this.totalBytesAllocated += totalBytes;
        this.context.log(`Allocated CPU-side tile storage for face ${CubeFace[face]}, LoD ${lod} (new: ${totalBytes / (1024 * 1024)} MB, total: ${this.totalBytesAllocated / (1024 * 1024)} MB)`)
    }

    private disableLinearTextureFiltering() {
        this.linearTextureFilteringEnabled = false;
        this.context.log("Linear minFilter on all textures disabled");

        for (let face = 0; face < 6; face++) {
            for (let lod = 0; lod <= this.context.interaction.selectedCubeMetadata.max_lod; lod++) {
                const material = this.context.rendering.cube.material[face];
                const texture = material.uniforms[`tilesLod${lod}`].value as DataArrayTexture;
                if (!texture) {   
                    continue;
                }
                texture.minFilter = NearestFilter;
                texture.needsUpdate = true;
            }
        }
    }
    
    resetTileStatistics() {
       this.tileDownloadsTriggered = 0;
       this.tileDownloadsFinished = 0;
       this.tileDownloadsFailed = 0;
       this.tileDecodesFailed = 0;
    }

    updateStatusMessage() {
        if (!this.context.widgetMode) {
            this.context.interaction.updateStatusMessage(this.tileDownloadsTriggered, this.tileDownloadsFinished, this.tileDownloadsFailed, this.tileDecodesFailed);
        }
    }
    
    resetDataStatistics() {
        this.observedMinValue = Infinity;
        this.observedMaxValue = -Infinity;
        this.observedValuesCount = 0;
        this.observedValuesMean = 0;
        this.observedValuesVariance = 0;
        this.statisticalColormapLowerBound = 0;
        this.statisticalColormapUpperBound = 0;
        this.colorsNotFound = 0;
        this.linearTextureFilteringEnabled = this.context.linearTextureFilteringEnabled;
    }

    resetTileMaps() {
        this.tileDownloadsTriggered = 0;
        this.tileDownloadsFinished = 0;
        this.tileDownloadsFailed = 0;
        this.tileDecodesFailed = 0;
        this.maxCompressionErrors.clear();
        this.tilesDownloadTriggered.splice(0, this.tilesDownloadTriggered.length);
        this.tilesDownloadFinished.splice(0, this.tilesDownloadFinished.length);
        for (let i = 0; i < 6; i++) {
            this.tilesDownloadTriggered.push(new Map<string, boolean>());
            this.tilesDownloadFinished.push(new Map<string, boolean>());
        }
    }
    
    getDataValue(face: CubeFace, lod: number, tileX: number, tileY: number, pixelX: number, pixelY: number) {
        const xTiles = this.context.interaction.cubeDimensions.xTilesForFace(face, lod);
        const tileIndex = tileX + tileY * xTiles;
        const indexOffset = tileIndex * TILE_SIZE * TILE_SIZE;
        if (!this.tileStoragesFloat[face][lod] || this.tileStoragesFloat[face][lod].length == 0) {
            return { 
                value: NaN, 
                isDataNan: false, 
                isDataNotLoaded: true
            }
        }
        const value = this.tileStoragesFloat[face][lod][indexOffset + pixelX + pixelY * TILE_SIZE];
        return { 
            value: (value == NAN_REPLACEMENT_VALUE || value == NOT_LOADED_REPLACEMENT_VALUE) ? NaN : value, 
            isDataNan: value == NAN_REPLACEMENT_VALUE, 
            isDataNotLoaded: value == NOT_LOADED_REPLACEMENT_VALUE 
        }
    }

    addTileDownloadsTriggered(value: number = 1) {
        this.tileDownloadsTriggered += value;
        this.updateStatusMessage();
    }

    addTileDownloadsFinished(value: number = 1) {
        this.tileDownloadsFinished += value;
        this.updateStatusMessage();
    }

    isTileDownloadFinished(tile: Tile) {
        return this.tilesDownloadFinished[tile.face].get(tile.getHashKey());
    }

    isTileDownloadTriggered(tile: Tile) {
        const key = tile.getHashKey()
        if (this.tilesDownloadTriggered[tile.face].get(key)) {
            return true;
        }
        this.tilesDownloadTriggered[tile.face].set(key, true);
        return false;
    }

    resetTileDownloadMapsForFace(face: CubeFace) {
        this.tilesDownloadTriggered[face].clear();
        this.tilesDownloadFinished[face].clear();
    }
}

export { TileData, Tile }
