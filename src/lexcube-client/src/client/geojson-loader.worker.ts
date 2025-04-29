import FastLineSegmentMap from "./fast-line-segment-map";
import { expose } from 'comlink';


const parseGeoJSON = async (geoJsonOrUrl: any, segmentMapBins: number) => {
    if (geoJsonOrUrl == null) {
        throw new Error("GeoJSON or URL is required");
    }
    if (geoJsonOrUrl instanceof String || typeof geoJsonOrUrl == "string") {
        if (geoJsonOrUrl.startsWith("http") || geoJsonOrUrl.startsWith("/")) {
            const loadedBorders = await fetch(geoJsonOrUrl as string);
            geoJsonOrUrl = await loadedBorders.json();
        } else {
            geoJsonOrUrl = JSON.parse(geoJsonOrUrl as string);
        }
    }
    
    const indices: number[] = [];
    const positions: number[] = [];

    let polygonsParsed = 0;
    let featuresSkipped = 0;

    const positionDictionary: { [key: string]: number } = {};
    const lineDictionary: { [key: string]: number } = {};

    const getPositionIndex = (pixelX: number, pixelY: number): number => {
        const newKey = `${pixelX}-${pixelY}`;
        const readPositionNew = positionDictionary[newKey];
        if (readPositionNew !== undefined) {
            return readPositionNew;
        }
        positionDictionary[newKey] = positions.length / 3;
        positions.push(0, pixelY, -pixelX);
        return positions.length / 3 - 1;
    }

    // Creates a line between two points if it doesn't already exist, i.e., merge identical lines in the GeoJSON and represent them as a single line
    const makeLine = (index1: number, index2: number) => {
        const newKey = `${Math.min(index1, index2)}-${Math.max(index1, index2)}`;
        const readlineNew = lineDictionary[newKey];
        if (readlineNew !== undefined) {
            return readlineNew;
        }
        lineDictionary[newKey] = indices.length / 2;
        indices.push(index1, index2);
    }

    const parsePolygon = (polygonCoords: number[][]) => {
        let lastPositionIndex = 0;
        for (let i = 0; i <= polygonCoords.length; i++) {
            const nextPoint = polygonCoords[i % polygonCoords.length];
            const pixelX = nextPoint[0] as number;
            const pixelY = nextPoint[1] as number;
            const thisPositionIndex = getPositionIndex(pixelX, pixelY);
            if (i > 0) {
                makeLine(thisPositionIndex, lastPositionIndex);
            }
            lastPositionIndex = thisPositionIndex;
        }
        polygonsParsed += 1;
    }

    const parsePoint = (pointCoords: number[]) => {
        // make a little diamond
        const pixelX = pointCoords[0] as number;
        const pixelY = pointCoords[1] as number;
        const p = 0.001;
        positions.push(0, pixelY, -pixelX + p);
        positions.push(0, pixelY + p, -pixelX);
        positions.push(0, pixelY, -pixelX - p);
        positions.push(0, pixelY - p, -pixelX);

        const startIndex = indices.length / 2;
        indices.push(startIndex, startIndex + 1);
        indices.push(startIndex + 1, startIndex + 2);
        indices.push(startIndex + 2, startIndex + 3);
        indices.push(startIndex + 3, startIndex);
    }

    const parseLine = (lineCoords: number[][]) => {
        for (let i = 0; i < lineCoords.length - 1; i++) {
            const startCoords = lineCoords[i];
            const endCoords = lineCoords[i + 1];
            const pixelX1 = startCoords[0] as number;
            const pixelY1 = startCoords[1] as number;
            const pixelX2 = endCoords[0] as number;
            const pixelY2 = endCoords[1] as number;
            positions.push(0, pixelY1, -pixelX1);
            positions.push(0, pixelY2, -pixelX2);
            const startIndex = indices.length / 2;
            indices.push(startIndex, startIndex + 1);
        }
    }


    for (let feature of geoJsonOrUrl.features) {
        if (feature.geometry.type == "MultiPolygon") {
            for (let shape of feature.geometry.coordinates) {
                for (let coords of shape) {
                    parsePolygon(coords as number[][]);
                }
            }
        } else if (feature.geometry.type == "Polygon") {
            const coords = feature.geometry.coordinates[0];
            parsePolygon(coords as number[][]);
        } else if (feature.geometry.type == "Point") {
            parsePoint(feature.geometry.coordinates as number[]);
        } else if (feature.geometry.type == "MultiPoint") {
            for (let point of feature.geometry.coordinates) {
                parsePoint(point as number[]);
            }
        } else if (feature.geometry.type == "MultiLineString") {
            for (let line of feature.geometry.coordinates) {
                parseLine(line as number[][]);
            }
        } else if (feature.geometry.type == "LineString") {
            parseLine(feature.geometry.coordinates as number[][]);
        } else {
            featuresSkipped += 1;
        }
    }
    
    const lineSegmentMapZ = new FastLineSegmentMap(2, segmentMapBins, positions, indices);
    const lineSegmentMapY = new FastLineSegmentMap(1, segmentMapBins, positions, indices);

    return { indices: indices, positions: positions, lineSegmentMapY, lineSegmentMapZ };
}

const geoJSONWorkerApi = {
    parseGeoJSON
};

export type GeoJSONWorkerApi = typeof geoJSONWorkerApi;

expose(geoJSONWorkerApi);

