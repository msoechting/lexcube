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

import { AmbientLight, BoxGeometry, DataTexture, DataArrayTexture, DirectionalLight, FloatType, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, Raycaster, RedFormat, RGBAFormat, RGBFormat, Scene, ShaderMaterial, Triangle, Vector2, Vector3, WebGLRenderer, Line, BufferGeometry, Object3D, LineBasicMaterial, Frustum, Matrix4, Plane, Box3, LineSegments, Float32BufferAttribute, SphereGeometry, MeshStandardMaterial, CylinderGeometry, AnimationMixer, AnimationClip, NumberKeyframeTrack, KeyframeTrack, InterpolateSmooth, BooleanKeyframeTrack, Clock, AnimationAction, AddEquation, CustomBlending, OneMinusSrcAlphaFactor, SrcAlphaFactor, Color, MaxEquation, OneFactor, MinEquation, AlwaysStencilFunc, ReplaceStencilOp } from 'three'
import { clamp, lerp } from 'three/src/math/MathUtils';
import { toPng, toCanvas, getFontEmbedCSS, toBlob } from 'html-to-image';
import { ArrayBufferTarget as WebmArrayBufferTarget, Muxer as WebmMuxer } from 'webm-muxer'
import { ArrayBufferTarget as Mp4ArrayBufferTarget, Muxer as Mp4Muxer } from 'mp4-muxer'
import { COLORMAP_STEPS, CubeFace, DEFAULT_FOV, DEFAULT_WIDGET_HEIGHT, DEFAULT_WIDGET_WIDTH, Dimension, getAddressedFacesOfDimension, getFacesOfIndexDimension, NAN_REPLACEMENT_VALUE, NOT_LOADED_REPLACEMENT_VALUE, range, TILE_SIZE } from './constants';
import { CubeClientContext } from './client';
import FastLineSegmentMap from './fast-line-segment-map';
import { wrap } from 'comlink';
import { GeoJSONWorkerApi } from './geojson-loader.worker';
import { Encoder as GifEncoder } from 'modern-gif'

enum RecordingFileFormat {
    MP4 = 0,
    WebM = 1,
    GIF = 2,
}

interface FixedFrameCanvasRecorder {
    startCapture(log: (...params: any[]) => void, filename: string): void;
    recordFrame(lastFrame: boolean): Promise<void>;
    requestFinishCapture(postDownload: () => void): Promise<void>;
}

class FixedFrameGifCanvasRecorder implements FixedFrameCanvasRecorder {
    private width: number;
    private height: number;
    private filename: string = "";
    private fps: number;

    private canvas: HTMLCanvasElement;

    private htmlParent: HTMLElement;
    private requestedFinish: boolean;
    private framesReceived: number;
    private htmlNodeFilterFunction: ((domNode: HTMLElement) => boolean) | undefined;
    private fontEmbedCSS: string | undefined;
    
    private encoder: GifEncoder;
    
    constructor(htmlParent: HTMLElement, canvas: HTMLCanvasElement, filterFunction: (e: HTMLElement) => boolean, recordingFileFormat: RecordingFileFormat, fps: number) {
        this.requestedFinish = false;
        this.framesReceived = 0;
        this.htmlNodeFilterFunction = filterFunction;
        this.htmlParent = htmlParent;
        this.fps = fps;
        this.canvas = canvas.cloneNode() as HTMLCanvasElement;

        const maxSize = 1920 * 1080;
        if (this.canvas.width * this.canvas.height > maxSize) {
            const scale = Math.sqrt(maxSize / (this.canvas.width * this.canvas.height));
            this.canvas.width = Math.round(this.canvas.width * scale);
            this.canvas.height = Math.round(this.canvas.height * scale);
        }

        this.width = this.canvas.width;
        this.height = this.canvas.height;

        this.encoder = new GifEncoder({
            height: this.height,
            width: this.width
        });
    }

    async startCapture(log: (...params: any[]) => void, filename: string) {
        this.filename = filename;
        this.fontEmbedCSS = await getFontEmbedCSS(this.htmlParent);
    }

    async recordFrame(lastFrame: boolean) {
        if (this.requestedFinish) {
            return;
        }
        const frameId = this.framesReceived;
        this.framesReceived += 1;
    
        const newCanvas = await toCanvas(this.htmlParent, { "filter": this.htmlNodeFilterFunction, fontEmbedCSS: this.fontEmbedCSS, "style": { backgroundColor: "black" } });

        await this.encoder.encode({ data: newCanvas, delay: 1000 / this.fps });
        newCanvas.remove();
    }

    async requestFinishCapture(postDownload: () => void) {
        this.requestedFinish = true;
        window.setTimeout(async () => {
            await this.finishCapture();
            postDownload();
        }, 1);
    }

    private async finishCapture() {
        const gifBlob = await this.encoder.flush("blob");
        this.download(gifBlob, this.filename);
    }

    private download(gifBlob: Blob, filename: string) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(gifBlob);
        a.download = `${filename}.gif`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.setTimeout(() => {
            URL.revokeObjectURL(a.href);
        }, 60000); // revoke video blob after 60 seconds
    }
}

// adapted from https://github.com/w3c/mediacapture-record/issues/213#issuecomment-1430325280
class FixedFrameVideoEncoderCanvasRecorder implements FixedFrameCanvasRecorder {
    private fps: number;
    private width: number;
    private height: number;
    private bitrate: number;
    private videoEncoder!: VideoEncoder;
    private reader!: ReadableStreamDefaultReader<VideoFrame>;

    private webmMuxer!: WebmMuxer<WebmArrayBufferTarget>;
    private mp4Muxer!: Mp4Muxer<Mp4ArrayBufferTarget>;

    private framesReceived = 0;
    private framesEncoded: number = 0;

    private webmTarget!: WebmArrayBufferTarget;
    private mp4Target!: Mp4ArrayBufferTarget;

    private track!: MediaStreamTrack;
    private canvas!: HTMLCanvasElement;
    private htmlNodeFilterFunction: (e: HTMLElement) => boolean;
    private htmlParent: HTMLElement;
    private requestedFinish: boolean = false;

    private recordingFileFormat: RecordingFileFormat;
    private fontEmbedCSS: string | undefined;

    private captureFinished: boolean = false;
    private postDownload: (() => void) | undefined = undefined;
    
    private filename: string = "lexcube-animation";

    constructor(htmlParent: HTMLElement, canvas: HTMLCanvasElement, filterFunction: (e: HTMLElement) => boolean, recordingFileFormat: RecordingFileFormat, fps: number) {
        this.htmlParent = htmlParent;
        this.canvas = canvas.cloneNode() as HTMLCanvasElement;
        this.htmlNodeFilterFunction = filterFunction;
        this.fps = fps;
        this.recordingFileFormat = recordingFileFormat;
        // round up width to next even number
        this.width = Math.ceil(canvas.width / 2) * 2;
        this.height = Math.ceil(canvas.height / 2) * 2;
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        // calculate bitrate based on resolution
        this.bitrate = this.width * this.height * 6 * this.fps / 10; // 22.1 Mbs for 1440p
    }
  
    private async finishEncoding() {
        await this.videoEncoder.flush();
        this.getMuxer().finalize();
        try {
            this.reader.releaseLock();
        } catch (e) {
            console.error(e);
        }
    }

    private async encodeFrame(frame: VideoFrame, repeatFrame: number = 0) {
        const keyFrame = this.framesReceived % 10 === 0; // keyframe every 10 frames
        this.videoEncoder.encode(frame, { keyFrame });
        if (repeatFrame > 0) {
            for (let i = 0; i < repeatFrame; i++) {
                this.videoEncoder.encode(frame, { keyFrame: false });
            }
        }
        frame.close();
    }

    private getMuxer() {
        return this.recordingFileFormat == RecordingFileFormat.MP4 ? this.mp4Muxer : this.webmMuxer;
    }

    async startCapture(log: (...params: any[]) => void, filename: string) {
        this.filename = filename;
        this.videoEncoder = new VideoEncoder({
            output: (chunk, meta) => {
                this.getMuxer().addVideoChunk(chunk, meta, this.framesEncoded * 1e6 / this.fps);
                this.framesEncoded += 1;
                if (this.requestedFinish && this.framesEncoded == this.framesReceived) { // bug: does not consider repeatFrame
                    this.finishCapture();
                }
            },
            error: (e) => console.error(e),
        });


        const possibleWebmCodecs = new Map<string, string>([['V_AV1', 'av01.0.05M.08'], ['V_VP9', 'vp09.00.10.08'], ['V_VP8', 'vp8']]);
        const possibleMp4Codecs = new Map<string, string>([['avc', 'avc1.420033'], ['hevc', 'hvc1.1.6.L93.90'], ['vp9', 'vp09.00.10.08'], ['av1', 'av01.0.05M.08']]);
        const possibleMp4CodecIds = ["avc", "hevc", "vp9", "av1"] as const;
        let chosenCodecId = "";
        
        if (this.recordingFileFormat == RecordingFileFormat.MP4) {
            log(`[Recording Setup] Testing MP4 codecs`);
            for (let [codecId, codecString] of possibleMp4Codecs) {
                const config = {
                    codec: codecString,
                    width: this.width,
                    height: this.height,
                    bitrate: this.bitrate,
                    bitrateMode: "constant"
                };
        
                if ((await VideoEncoder.isConfigSupported(config as any)).supported) {
                    this.videoEncoder.configure(config as any);
                    chosenCodecId = codecId;
                    log(`[Recording Setup] Chose codec ${codecId} & MP4`);
                    break;
                }
            }
        }

        if (this.recordingFileFormat == RecordingFileFormat.WebM) {
            log("[Recording Setup] Testing WebM codecs");
            for (let [codecId, codecString] of possibleWebmCodecs) {
                const config = {
                    codec: codecString,
                    width: this.width,
                    height: this.height,
                    bitrate: this.bitrate,
                    bitrateMode: "constant"
                };
        
                if ((await VideoEncoder.isConfigSupported(config as any)).supported) {
                    this.videoEncoder.configure(config as any);
                    chosenCodecId = codecId;
                    log(`[Recording Setup] Chose codec ${codecId} & WebM`);
                    break;
                }
            }
        }

        if (chosenCodecId == "") {
            log(`[Recording Setup] No supported codec found`);
            throw new Error("No supported codec found");
        }
        
        if (this.recordingFileFormat == RecordingFileFormat.MP4) {
            this.mp4Target = new Mp4ArrayBufferTarget();
            this.mp4Muxer = new Mp4Muxer({
                target: this.mp4Target,
                fastStart: "in-memory",
                video: {
                    codec: possibleMp4CodecIds.find((id) => id == chosenCodecId) || "avc",
                    width: this.width,
                    height: this.height,
                    frameRate: this.fps
                },
            });
        } else {
            this.webmTarget = new WebmArrayBufferTarget();
            this.webmMuxer = new WebmMuxer({
                target: this.webmTarget,
                video: {
                    codec: chosenCodecId,
                    width: this.width,
                    height: this.height,
                    frameRate: this.fps,
                },
            });
        }
        
        this.fontEmbedCSS = await getFontEmbedCSS(this.htmlParent);
        
        const ctx = this.canvas.getContext('2d')!;
        ctx.fillStyle = 'black';
        ctx.clearRect(0, 0, this.width, this.height);

        this.track = this.canvas.captureStream(0).getVideoTracks()[0];
        // @ts-expect-error 
        const mediaProcessor = new MediaStreamTrackProcessor(this.track); // does not work on firefox, oops
        this.reader = mediaProcessor.readable.getReader();

        // @ts-expect-error
        this.track.requestFrame(); // fix black frames at start
        (await this.reader.read()).value?.close(); // flush the first frame
    }

    async recordFrame(lastFrame: boolean = false) {
        if (this.requestedFinish) {
            return;
        }
        const frameId = this.framesReceived;
        this.framesReceived += 1;
    
        const newCanvas = await toCanvas(this.htmlParent, { "filter": this.htmlNodeFilterFunction, fontEmbedCSS: this.fontEmbedCSS, "style": { backgroundColor: "black" } });
        const ctx = this.canvas.getContext('2d')!;
        ctx.drawImage(newCanvas, 0, 0, this.canvas.width, this.canvas.height);
        newCanvas.remove();
        // ctx.fillStyle = 'white';
        // ctx.font = '50px sans-serif';
        // ctx.fillText(`Frame ${frameId}`, 10, 50);
        
        // @ts-expect-error
        this.track.requestFrame();
        const result = await this.reader.read();
        const frame = result.value;
        await this.encodeFrame(frame!, lastFrame ? 1 : 0); // encode last frame twice to make sure it's visible - bug: this does not happen when animation is manually stopped
        frame?.close();
    }

    private getTarget() {
        return this.recordingFileFormat == RecordingFileFormat.MP4 ? this.mp4Target : this.webmTarget;
    }

    private download(filename: string) {
        const format = this.recordingFileFormat == RecordingFileFormat.MP4 ? "mp4" : "webm";
        const a = document.createElement('a');
        const blob = new Blob([this.getTarget().buffer], { type: `video/${format}` });
        a.href = URL.createObjectURL(blob);
        a.download = `${filename}.${format}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.setTimeout(() => {
            URL.revokeObjectURL(a.href);
        }, 60000); // revoke video blob after 60 seconds
    }

    async requestFinishCapture(postDownload: () => void) {
        this.requestedFinish = true;
        this.postDownload = postDownload;
        window.setTimeout(async () => {
            await this.finishCapture(); // as a safeguard for the race condition going on with receiving vs encoding frames
        }, 1500);
    }


    private async finishCapture() {
        if (this.captureFinished) {
            return;
        }
        this.captureFinished = true;
        if (this.framesEncoded == 0) {
            return this.postDownload!();
        }
        await this.finishEncoding();
        this.download(this.filename);
        this.postDownload!();
    }    
}

class LabelPositionResult {
    visible: boolean = false;
    screenPositionMinLabel!: Vector2;
    screenPositionMaxLabel!: Vector2; 
    screenPositionNameLabel!: Vector2; 
    angleMinLabel!: number; 
    angleMaxLabel!: number; 
    angleNameLabel!: number; 
}

enum NaturalEarthRegionBorderResolution {
    "Highest" = 10,
    "High" = 50,
    "Default" = 110,
}

class Edge {
    p1: Vector3;
    p2: Vector3;
    dimension: Dimension;

    constructor(p1: Vector3, p2: Vector3, dimension: Dimension) {
        this.p1 = p1;
        this.p2 = p2;
        this.dimension = dimension;
    }

    clone() {
        return new Edge(this.p1, this.p2, this.dimension);
    }

    sharesP1With(other: Edge) {
        return this.p1.equals(other.p1) || this.p1.equals(other.p2);
    }

    sharesP2With(other: Edge) {
        return this.p2.equals(other.p1) || this.p2.equals(other.p2);
    }
    
    middle() {
        return this.p1.clone().add(this.p2).divideScalar(2);
    }

    equals(other: Edge) {
        return this.p1.equals(other.p1) && this.p2.equals(other.p2) && this.dimension == other.dimension;
    }

    isIdenticalLine(other: Edge) {
        return (this.p1.equals(other.p1) && this.p2.equals(other.p2));
    }

    lerpedWith(other: Edge) {
        return new Edge(new Vector3().lerpVectors(this.p1, other.p1, 0.5), new Vector3().lerpVectors(this.p2, other.p2, 0.5), this.dimension);
    }

    reverse() {
        const newP1 = this.p2;
        this.p2 = this.p1;
        this.p1 = newP1;
    }

    getDirection() {
        return this.p2.clone().sub(this.p1);
    }
}

class CubeRendering {
    private renderer: THREE.WebGLRenderer;
    mainCamera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
    private scene: THREE.Scene;
    cube: THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial[]>;
    
    displayQuality = 1.0;

    private totalSizes: Vector2[];
    lods: number[];
    faceVisibility: Array<boolean> = new Array<boolean>(false, false, false, false, false, false);
    private faceCurrentPixels: number[] = [0,0,0,0,0,0];
    private rayCaster: Raycaster = new Raycaster();
    private context: CubeClientContext;
    
    private colormapData: Uint8Array;
    renderDebugCubes: boolean;
    debugCubes: THREE.Mesh[];
    private allTilesDownloaded: boolean = false;
    private parent: HTMLElement;

    private renderRequested: boolean = true;
    
    private regionBordersTransparency: number = 0.6;
    private regionBordersFrontMaterial!: THREE.LineBasicMaterial;
    private regionBordersFrontParent!: THREE.Object3D;
    private regionBordersFrontActiveLocalParent!: THREE.Object3D;
    private regionBordersFrontAtDifferentResolutions: Map<NaturalEarthRegionBorderResolution, THREE.Object3D> = new Map<NaturalEarthRegionBorderResolution, THREE.Object3D>();
    private currentRegionBorderResolution = 0;
    private regionBorderResolutionsBeingLoaded = new Set<NaturalEarthRegionBorderResolution>();
    private regionBorderFrontSegmentMapBins = 10000;

    private regionBordersDistanceFromCubeCenter = 0.501; // just a bit in front of the cube

    private regionBordersSideMaterial!: THREE.LineBasicMaterial;
    private regionBordersSideParent!: THREE.Object3D;
    
    private maxRangeIndicatorClippingPlanes: Map<CubeFace, Plane> = new Map<CubeFace, Plane>();
    
    private regionBordersSidePlanes: Map<CubeFace, Plane> = new Map<CubeFace, Plane>();
    private regionBordersSideLines: Map<CubeFace, LineSegments> = new Map<CubeFace, LineSegments>();
    private regionBordersSideLinesInitialPoolAmount = 200;
    
    private lastSideRegionXLeft = 0;
    private lastSideRegionXRight = 0;
    private lastSideRegionYTop = 0;
    private lastSideRegionYBottom = 0;

    updateWidgetModelDimensionWrapSettings: (xWrap: boolean, yWrap: boolean, zWrap: boolean) => void = () => {};

    private canvasRecorder: FixedFrameCanvasRecorder | null = null;
    private recordingAnimation: boolean = false;

    private htmlClassesOptionalForScreenshots = ["bottom-left-ui", "axis-label-ui", "dataset-info-corner-parent"];
    private htmlClassesAlwaysInScreenshots = ["corner-logo-ui"];
    private htmlClassesNeverInScreenshots = ["hover-info-ui", "colormap-options"];
    private recordingFileFormat: RecordingFileFormat | null = RecordingFileFormat.MP4;
    
    private geoJsonLoaderWorker = new Worker(new URL('./geojson-loader.worker', import.meta.url));
    private geoJsonLoaderService = wrap<GeoJSONWorkerApi>(this.geoJsonLoaderWorker);

    private screenshotFontEmbedCss: string = "";
    
    private maxRangeIndicatorParent!: Object3D;
    private maxRangeIndicatorParentPerFace = new Map<CubeFace, Object3D>();
    private maxRangeIndicatorMap = new Map<string, Object3D>();

    private maxRangeIndicatorAnimationMixers: AnimationMixer[] = [];
    private maxRangeIndicatorAnimationActions: AnimationAction[] = [];
    private maxRangeIndicatorAnimationsPlaying = false;

    private animationClock: Clock = new Clock();

    private lastLabelEdges: (Edge | undefined)[] = [undefined, undefined, undefined];

    private debouncedVisibilityAndLodUpdateTimeoutHandler: number = 0;
    printTemplateDownloading: boolean = false;
    private printTemplateCurrentFace: number = 0;
    private printTemplateResults: string[] = [];
    
    private printTemplateCamera: OrthographicCamera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 100);
    dimensionOverflow: boolean[] = [false, false, false];
    
    private widgetModeWidth = DEFAULT_WIDGET_WIDTH;
    private widgetModeHeight = DEFAULT_WIDGET_HEIGHT;

    constructor(context: CubeClientContext, parent: HTMLElement) {
        this.context = context;
        this.parent = parent;
        this.colormapData = new Uint8Array(COLORMAP_STEPS * 4);
        this.colormapData.fill(128);

        this.totalSizes = new Array<Vector2>();
        this.lods = new Array<number>();

        this.scene = new Scene()
            
        if (context.isometricMode) {
            this.mainCamera = new OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
            this.mainCamera.position.setFromSphericalCoords( 
                4, 
                Math.PI / 3, // 60 degrees from positive Y-axis and 30 degrees to XZ-plane
                Math.PI / 4  // 45 degrees, between positive X and Z axes, thus on XZ-plane
            );
            this.updateOrthographicCamera();
        } else {
            let fov = DEFAULT_FOV;
            const matchFov = document.URL.match(/fov=(\d+\.?\d*)/);
            if (matchFov && matchFov.length > 0) {
                fov = parseInt(matchFov[1]);
            }
            this.mainCamera = new PerspectiveCamera(fov, this.getWidth() / this.getHeight(), 0.01, 10);
        }
    
        const frontLight = new DirectionalLight("white", 0.4)
        frontLight.position.set(1.0, 1.4, -0.7)
    
        const backLight = new DirectionalLight("white", 0.4)
        backLight.position.set(-1.0, 1.4, 0.7)
    
        const ambientLight = new AmbientLight("white", 0.6);
    
        this.renderer = new WebGLRenderer({ 
            antialias: true, 
            alpha: this.context.studioMode || this.context.widgetMode,
            preserveDrawingBuffer: true 
        });
        this.renderer.setSize(this.getWidth(), this.getHeight());
        this.renderer.setPixelRatio(window.devicePixelRatio);
        // this.renderer.setClearColor(new THREE.Color("#000000"), 0);
        this.parent.appendChild(this.renderer.domElement);

        window.addEventListener('resize', this.onWindowResize.bind(this), false)

        const cubeGeometry = new BoxGeometry(1, 1, 1);

        const materials = Array.from({ length: 6 }, () => this.newCubeMaterial());
        this.cube = new Mesh(cubeGeometry, materials);
    
        this.setCubeLightingEnabled();
    
        this.renderDebugCubes = false;
        this.debugCubes = [];
        if (this.renderDebugCubes) {
            for (let i = 0; i < 20; i++) {
                const c = new Mesh(new BoxGeometry(0.02, 0.02, 0.02), new MeshBasicMaterial({ color: ["white","grey","yellow","green","purple"][i % 5] }));
                this.debugCubes.push(c)
                this.scene.add(c);
            }
        }
    
        // fix cube UVs
        var uvAttributes = this.cube.geometry.attributes.uv;
        for (let face = 0; face < 6; face++) {
            const offset = face * 4;
    
            if (face == CubeFace.Front) {
                // UV = from top left to bottom right of face
                uvAttributes.setXY(offset + 0, 0, 0); // top left
                uvAttributes.setXY(offset + 1, 1, 0); // top right
                uvAttributes.setXY(offset + 2, 0, 1); // bottom left
                uvAttributes.setXY(offset + 3, 1, 1); // bottom right
            } else if (face == CubeFace.Back) {
                // UV = from top right to bottom left of face
                uvAttributes.setXY(offset + 0, 1, 0); // top left
                uvAttributes.setXY(offset + 1, 0, 0); // top right
                uvAttributes.setXY(offset + 2, 1, 1); // bottom left
                uvAttributes.setXY(offset + 3, 0, 1); // bottom right
            } else if (face == CubeFace.Right) {
                // UV = from top left to bottom right of face, but XY flipped
                uvAttributes.setXY(offset + 0, 0, 1); // top left
                uvAttributes.setXY(offset + 1, 0, 0); // top right
                uvAttributes.setXY(offset + 2, 1, 1); // bottom left
                uvAttributes.setXY(offset + 3, 1, 0); // bottom right
            } else if (face == CubeFace.Top) {
                // UV = from bottom right to top left of face, but XY flipped
                uvAttributes.setXY(offset + 0, 1, 0); // top left
                uvAttributes.setXY(offset + 1, 1, 1); // top right
                uvAttributes.setXY(offset + 2, 0, 0); // bottom left
                uvAttributes.setXY(offset + 3, 0, 1); // bottom right
            } else if (face == CubeFace.Bottom || face == CubeFace.Left) {
                // UV = from top right to bottom left of face, but XY flipped
                uvAttributes.setXY(offset + 0, 0, 0); // top left
                uvAttributes.setXY(offset + 1, 0, 1); // top right
                uvAttributes.setXY(offset + 2, 1, 0); // bottom left
                uvAttributes.setXY(offset + 3, 1, 1); // bottom right
            }
        }
    
        this.scene.add(this.cube);
        this.scene.add(frontLight);
        this.scene.add(backLight);
        this.scene.add(ambientLight);
        this.createRegionBorders();

        this.createMaxRangeIndicators();
        
        (window as any)["saveCameraPreset"] = () => {
            const s = `{ position: new Vector3(${this.mainCamera.position.x}, ${this.mainCamera.position.y}, ${this.mainCamera.position.z}), rotation: new Euler(${this.mainCamera.rotation.x}, ${this.mainCamera.rotation.y}, ${this.mainCamera.rotation.z}) },`
            console.log(s)
        }
    }

    private createMaxRangeIndicators() {
        const color = 0xffffff;
        const indicatorWidth = 0.0075;
        const indicatorLength = 1 + indicatorWidth;
        const indicatorDistance = 0.5 + indicatorWidth / 2 + 0.0015; // some padding for clipping

        this.maxRangeIndicatorClippingPlanes.set(CubeFace.Front, new Plane(new Vector3(1, 0, 0), indicatorDistance));
        this.maxRangeIndicatorClippingPlanes.set(CubeFace.Back, new Plane(new Vector3(-1, 0, 0), indicatorDistance));
        this.maxRangeIndicatorClippingPlanes.set(CubeFace.Top, new Plane(new Vector3(0, 1, 0), indicatorDistance));
        this.maxRangeIndicatorClippingPlanes.set(CubeFace.Bottom, new Plane(new Vector3(0, -1, 0), indicatorDistance));
        this.maxRangeIndicatorClippingPlanes.set(CubeFace.Left, new Plane(new Vector3(0, 0, 1), indicatorDistance));
        this.maxRangeIndicatorClippingPlanes.set(CubeFace.Right, new Plane(new Vector3(0, 0, -1), indicatorDistance));

        const opacityAnimationTimePoints = [0, 0.8, 1.0]; // Time in seconds
        const opacityAnimationValues = [1.0, 0.3, 0]; // Opacity values at each time point
        const visibilityAnimationValues = [true, true, false]; // Visibility values at each time point
        
        this.maxRangeIndicatorParent = new Object3D();
        this.scene.add(this.maxRangeIndicatorParent);

        for (let face = 0; face < 6; face++) {            
            const p = new Object3D();
            this.maxRangeIndicatorParent.add(p);
            this.maxRangeIndicatorParentPerFace.set(face, p);
        }

        // Define keyframes for opacity animation
        const opacityKF = new NumberKeyframeTrack('.material.opacity', opacityAnimationTimePoints, opacityAnimationValues, InterpolateSmooth);
        const visibleKF = new BooleanKeyframeTrack('.visible', opacityAnimationTimePoints, visibilityAnimationValues);

        // Create an animation clip
        const clip = new AnimationClip("flash-and-fade", -1, [opacityKF, visibleKF]);
        
        const makeMesh = (id: string) => {
            const boxGeometry = new BoxGeometry(indicatorWidth, indicatorLength, indicatorWidth);
            const material = new MeshBasicMaterial({ 
                color: color, 
                transparent: true, 
                depthTest: false, 
                clippingPlanes: Array.from(this.maxRangeIndicatorClippingPlanes.values()),
            });
            const mesh = new Mesh(boxGeometry, material);
            mesh.visible = false;

            // Set up an AnimationMixer and play the clip
            const mixer = new AnimationMixer(mesh);
            const action = mixer.clipAction(clip, mesh);
            action.setLoop(0, 1);

            this.maxRangeIndicatorAnimationMixers.push(mixer);
            this.maxRangeIndicatorAnimationActions.push(action);

            mesh.userData.mixer = mixer;
            mesh.userData.action = action;
            mesh.userData.dimension = Dimension[id.split("-")[2].toUpperCase() as keyof typeof Dimension];

            const faceStr = id.split("-")[0];
            const face = CubeFace[faceStr.toUpperCase()[0] + faceStr.slice(1) as keyof typeof CubeFace];
            this.maxRangeIndicatorParentPerFace.get(face)!.add(mesh);
            this.maxRangeIndicatorMap.set(id, mesh);
            return mesh;
        }

        // Left to right, in default view
        const createIndicatorZ = (x: number, y: number, id: string) => {
            const mesh = makeMesh(id);
            mesh.rotation.set(Math.PI / 2, 0, 0);
            mesh.position.set(x, y, 0);
        }

        // Down to up, in default view
        const createIndicatorY = (x: number, z: number, id: string) => {
            const mesh = makeMesh(id);
            mesh.position.set(x, 0, z);
        }

        // Front to back, in default view
        const createIndicatorX = (y: number, z: number, id: string) => {
            const mesh = makeMesh(id);
            mesh.position.set(0, y, z);
            mesh.rotation.set(0, 0, Math.PI / 2);
        }
        
        createIndicatorZ(0.5, 0.5, "front-min-y");
        createIndicatorZ(0.5, -0.5, "front-max-y");
        createIndicatorZ(-0.5, 0.5, "back-min-y");
        createIndicatorZ(-0.5, -0.5, "back-max-y");
                
        createIndicatorY(0.5, 0.5, "left-max-y");
        createIndicatorY(0.5, -0.5, "right-max-y");
        createIndicatorY(-0.5, 0.5, "left-min-y");
        createIndicatorY(-0.5, -0.5, "right-min-y");
        
        createIndicatorX(0.5, 0.5, "top-min-x");
        createIndicatorX(0.5, -0.5, "top-max-x");
        createIndicatorX(-0.5, 0.5, "bottom-min-x");
        createIndicatorX(-0.5, -0.5, "bottom-max-x");
        
        createIndicatorZ(0.5, 0.5, "top-max-y");
        createIndicatorZ(0.5, -0.5, "bottom-max-y");
        createIndicatorZ(-0.5, 0.5, "top-min-y");
        createIndicatorZ(-0.5, -0.5, "bottom-min-y");
                
        createIndicatorY(0.5, 0.5, "front-min-x");
        createIndicatorY(0.5, -0.5, "front-max-x");
        createIndicatorY(-0.5, 0.5, "back-min-x");
        createIndicatorY(-0.5, -0.5, "back-max-x");
        
        createIndicatorX(0.5, 0.5, "left-min-x");
        createIndicatorX(0.5, -0.5, "right-min-x");
        createIndicatorX(-0.5, 0.5, "left-max-x");
        createIndicatorX(-0.5, -0.5, "right-max-x");
    }

    private updateMaxRangeIndicatorPositionAndScale() {
        for (let face = 0; face < 6; face++) {
            const faceParent = this.maxRangeIndicatorParentPerFace.get(face)!;
            const currentSize = this.context.interaction.cubeSelection.getSizeVector(face);
            const currentOffset = this.context.interaction.cubeSelection.getOffsetVector(face);
            
            const xParameterRange = this.context.interaction.cubeDimensions.xParameterRangeForFace(face);
            const yParameterRange = this.context.interaction.cubeDimensions.yParameterRangeForFace(face);

            const worldSize = new Vector2(xParameterRange.length(), yParameterRange.length());
            const worldOffset = new Vector2(xParameterRange.min, yParameterRange.min);
            const globalCenterPoint = worldSize.clone().divideScalar(2).add(worldOffset);
            const currentCenterPoint = currentSize.clone().divideScalar(2).add(currentOffset); 
            
            const zoomRelativeToWorld = new Vector2().copy(worldSize).divide(currentSize);
            
            if (face == CubeFace.Front || face == CubeFace.Back) {
                // mapping: local x is global -z, local y is global -y
                faceParent.scale.set(1.0, zoomRelativeToWorld.y, zoomRelativeToWorld.x);
                faceParent.position.setY(zoomRelativeToWorld.y * (currentCenterPoint.y - globalCenterPoint.y) / worldSize.y);
                faceParent.position.setZ(zoomRelativeToWorld.x * (currentCenterPoint.x - globalCenterPoint.x) / worldSize.x);
                
                 for (let mesh of faceParent.children) {
                     if (mesh.userData.dimension == Dimension.X) {
                        mesh.scale.set(1.0, 1.0, 1.0 / zoomRelativeToWorld.x);
                     } else {
                        mesh.scale.set(1.0, this.dimensionOverflow[Dimension.X] ? 3.0 : 1.0, 1.0 / zoomRelativeToWorld.y);
                     }
                 }
            } else if (face == CubeFace.Top || face == CubeFace.Bottom) {
                // local x is global -z, local y is global +x!
                faceParent.scale.set(zoomRelativeToWorld.y, 1.0, zoomRelativeToWorld.x);
                faceParent.position.setX(-zoomRelativeToWorld.y * (currentCenterPoint.y - globalCenterPoint.y) / worldSize.y);
                faceParent.position.setZ(zoomRelativeToWorld.x * (currentCenterPoint.x - globalCenterPoint.x) / worldSize.x);
                
                for (let mesh of faceParent.children) {
                    if (mesh.userData.dimension == Dimension.X) {
                        mesh.scale.set(1.0, 1.0, 1.0 / zoomRelativeToWorld.x);
                    } else {
                        mesh.scale.set(1.0 / zoomRelativeToWorld.y, this.dimensionOverflow[Dimension.X] ? 3.0 : 1.0, 1.0);
                    }
                }
            } else {
                // local x is global -y, local y is global +x!
                faceParent.scale.set(zoomRelativeToWorld.y, zoomRelativeToWorld.x, 1.0);
                faceParent.position.setX(-zoomRelativeToWorld.y * (currentCenterPoint.y - globalCenterPoint.y) / worldSize.y);
                faceParent.position.setY(zoomRelativeToWorld.x * (currentCenterPoint.x - globalCenterPoint.x) / worldSize.x);
                
                for (let mesh of faceParent.children) {
                    if (mesh.userData.dimension == Dimension.X) {
                        mesh.scale.set(1.0 / zoomRelativeToWorld.x, 1.0, 1.0);
                    } else {
                        mesh.scale.set(1.0 / zoomRelativeToWorld.y, 1.0, 1.0);
                    }
                }
            }
        }
    }

    showAllMaxRangeIndicators() {
        for (let face = 0; face < 6; face++) {
            this.showMaxRangeIndicator(face, Dimension.X, true);
            this.showMaxRangeIndicator(face, Dimension.X, false);
            this.showMaxRangeIndicator(face, Dimension.Y, true);
            this.showMaxRangeIndicator(face, Dimension.Y, false);
        }
    }

    showMaxRangeIndicator(face: CubeFace, dimension: Dimension, min: boolean) {
        const id = `${CubeFace[face].toLowerCase()}-${min ? "min" : "max"}-${Dimension[dimension].toLowerCase()}`;
        const mesh = this.maxRangeIndicatorMap.get(id);
        if (mesh) {
            mesh.userData.activeFace = face;
            mesh.userData.action.reset();
            mesh.userData.action.play();
            this.maxRangeIndicatorAnimationsPlaying = true;
            this.requestRender();
        } else {
            console.error(`Max range indicator with id ${id} not found`);
        }
    }

    private createRegionBordersSideLinePositions(face: CubeFace, lineAmount: number) {
        const y = face == CubeFace.Top ? this.regionBordersDistanceFromCubeCenter : face == CubeFace.Bottom ? -this.regionBordersDistanceFromCubeCenter : 0;
        const z = face == CubeFace.Left ? this.regionBordersDistanceFromCubeCenter : face == CubeFace.Right ? -this.regionBordersDistanceFromCubeCenter : 0;
        const positions: number[] = range(0, lineAmount * 6 - 1).map((i) => i % 3 == 0 ? (((Math.floor(i / 3) % 2 == 0) ? -this.regionBordersDistanceFromCubeCenter : this.regionBordersDistanceFromCubeCenter)) : (i % 3 == 1 ? y : z));
        return positions;
    }

    private createRegionBordersSideLines(face: CubeFace)  {
        const indices: number[] = [0,1];
        const positions = this.createRegionBordersSideLinePositions(face, this.regionBordersSideLinesInitialPoolAmount);
        const geometry = new BufferGeometry();
        geometry.setIndex(indices);
        geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
        geometry.computeBoundingSphere();

        const lineSegments = new LineSegments(geometry, this.regionBordersSideMaterial);
        lineSegments.visible = false;
        return lineSegments;
    };
    
    private createRegionBorders() {
        this.regionBordersSidePlanes.set(CubeFace.Top, new Plane(new Vector3(0, 1, 0), this.regionBordersDistanceFromCubeCenter));
        this.regionBordersSidePlanes.set(CubeFace.Bottom, new Plane(new Vector3(0, -1, 0), this.regionBordersDistanceFromCubeCenter));
        this.regionBordersSidePlanes.set(CubeFace.Left, new Plane(new Vector3(0, 0, 1), this.regionBordersDistanceFromCubeCenter));
        this.regionBordersSidePlanes.set(CubeFace.Right, new Plane(new Vector3(0, 0, -1), this.regionBordersDistanceFromCubeCenter));

        this.regionBordersSideParent = new Object3D();
        this.scene.add(this.regionBordersSideParent);

        this.regionBordersFrontMaterial = new LineBasicMaterial( { 
            linewidth: 1,
            transparent: true,
            color: 0x000000,
            opacity: this.regionBordersTransparency,
            clippingPlanes: Array.from(this.regionBordersSidePlanes.values())
        });

        this.regionBordersSideMaterial = new LineBasicMaterial( {
            linewidth: 1,
            color: 0x000000,
            transparent: true,
            opacity: this.regionBordersTransparency,
        });

        for (let face of [CubeFace.Top, CubeFace.Bottom, CubeFace.Left, CubeFace.Right]) {
            const lines = this.createRegionBordersSideLines(face);
            this.regionBordersSideLines.set(face, lines);
            this.regionBordersSideParent.add(lines);
        }
        
        this.regionBordersFrontParent = new Object3D();
        this.scene.add(this.regionBordersFrontParent);
        this.renderer.localClippingEnabled = true;
    }

    loadRegionBordersFromGeoJsonForWidget(geojson: any, color: string = "") {
        this.context.log("Loading GeoJSON for widget", geojson);
        this.loadRegionBorders(NaturalEarthRegionBorderResolution.Default, geojson);
        if (color) {
            this.setRegionBordersColor(color);
        }
    }

    clearRegionBordersForWidget() {
        this.clearRegionBorders();
    }

    setRegionBordersColor(color: string) {
        this.regionBordersFrontMaterial.color.set(color);
        this.regionBordersSideMaterial.color.set(color);
        this.regionBordersFrontMaterial.needsUpdate = true;
        this.regionBordersSideMaterial.needsUpdate = true;
        this.requestRender();
    }

    private regionBordersJustLoaded = false;

    private async loadRegionBorders(newResolution: NaturalEarthRegionBorderResolution = NaturalEarthRegionBorderResolution.Default, geojson: any = null) {
        this.regionBordersJustLoaded = true;
        if (this.context.widgetMode) {
            this.clearRegionBorders();
            const localParent = await this.loadRegionBordersFromGeoJson(geojson);
            this.regionBordersFrontActiveLocalParent = localParent!;
        } else {
            await this.loadRegionBordersFromNaturalEarth(newResolution);
        }
        this.updateRegionBorderPositionAndResolution();
        this.requestRender();
        this.regionBordersJustLoaded = false;
    }

    private async loadRegionBordersFromNaturalEarth(targetResolution: NaturalEarthRegionBorderResolution) {
        if (this.regionBordersFrontAtDifferentResolutions.has(targetResolution)) {
            this.context.log(`Region borders at resolution ${targetResolution} already loaded, making them visible`);
            const localParent = this.regionBordersFrontAtDifferentResolutions.get(targetResolution)!;
            localParent.visible = true;
            this.regionBordersFrontActiveLocalParent = localParent;
        } else {
            if (this.regionBorderResolutionsBeingLoaded.size > 0) {
                return false;
            }
            this.regionBorderResolutionsBeingLoaded.add(targetResolution);
            const localParent = await this.loadRegionBordersFromGeoJson(this.context.networking.getFetchUrl(`/ne_${targetResolution}m_admin_0_countries.geojson`));
            this.regionBordersFrontAtDifferentResolutions.set(targetResolution, localParent!);
            this.regionBorderResolutionsBeingLoaded.delete(targetResolution);
            this.regionBordersFrontActiveLocalParent = localParent!;
        }
        this.currentRegionBorderResolution = targetResolution;
        this.regionBordersFrontAtDifferentResolutions.forEach((localParent, resolution) => {
            if (resolution != targetResolution) {
                this.context.log(`Hiding region borders at resolution ${resolution}`);
                localParent.visible = false;
            }
        });
        return true;
    }

    private async clearRegionBorders() {
        this.regionBordersFrontParent.children.forEach((child) => {
            if (child instanceof LineSegments) {
                child.geometry.dispose();
            }
        });
        this.regionBordersFrontParent.remove(...this.regionBordersFrontParent.children);
    }

    private async loadRegionBordersFromGeoJson(geoJsonOrUrl: any) {
        if (!this.regionBordersFrontParent) {
            console.error("Region borders parent not initialized");
            return;
        }
        
        const { indices, positions, lineSegmentMapY, lineSegmentMapZ } = await this.geoJsonLoaderService.parseGeoJSON(geoJsonOrUrl, this.regionBorderFrontSegmentMapBins);
        const geometry = new BufferGeometry();
        geometry.setIndex(indices);
        geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
        geometry.computeBoundingSphere();

        const lineSegments = new LineSegments(geometry, this.regionBordersFrontMaterial);
        const lineParent = new Object3D();
        const lineParentOverflow = new Object3D(); 
        lineParent.add(lineSegments);
        
        const localParent = new Object3D();
        localParent.add(lineParent);
        localParent.add(lineParentOverflow);
        localParent.userData = {
            lineSegmentMapZ: FastLineSegmentMap.fromObject(lineSegmentMapZ),
            lineSegmentMapY: FastLineSegmentMap.fromObject(lineSegmentMapY),
            overflowActive: false,
            activateOverflow: () => {
                if (localParent.userData.overflowActive) {
                    return;
                }
                localParent.userData.overflowActive = true;
                this.context.log("Activating overflow for region borders");
                lineParentOverflow.add(lineSegments.clone());
            }
        };

        this.regionBordersFrontParent.add(localParent);
        return localParent;
    }

    private updateSideRegionBorders(xLeft: number, xRight: number, yTop: number, yBottom: number, worldSizeX: number) {
        if (!this.regionBordersFrontActiveLocalParent) {
            return;
        }

        const faceChanged = [
            this.lastSideRegionYTop != yTop, // top 2
            this.lastSideRegionYBottom != yBottom, // bottom 3
            this.lastSideRegionXLeft != xLeft, // left 4
            this.lastSideRegionXRight != xRight  // right 5
        ];

        faceChanged[0] = faceChanged[0] || faceChanged[2] || faceChanged[3]; // top face is influenced by top, left, and right, but NOT bottom
        faceChanged[1] = faceChanged[1] || faceChanged[2] || faceChanged[3]; // bottom face is influenced by bottom, left, and right, but NOT top
        faceChanged[2] = faceChanged[2] || faceChanged[0] || faceChanged[1]; // left face is influenced by left, top, and bottom, but NOT right
        faceChanged[3] = faceChanged[3] || faceChanged[0] || faceChanged[1]; // right face is influenced by right, top, and bottom, but NOT left
        
        const refreshEverything = this.printTemplateDownloading || this.printTemplateJustDownloaded;
        const skipCubeOffset = this.printTemplateDownloading;

        const frontLineSegments = this.regionBordersFrontActiveLocalParent.children[0].children[0] as LineSegments;
        const frontLinePositions = frontLineSegments.geometry.attributes.position.array;
        const centerX = (xLeft + xRight) / 2;
        const centerY = (yTop + yBottom) / 2;
        const xLeftAdjusted =   skipCubeOffset ? xLeft   : centerX + (xLeft - centerX)   * this.regionBordersDistanceFromCubeCenter / 0.5;
        const xRightAdjusted =  skipCubeOffset ? xRight  : centerX + (xRight - centerX)  * this.regionBordersDistanceFromCubeCenter / 0.5;
        const yTopAdjusted =    skipCubeOffset ? yTop    : centerY + (yTop - centerY)    * this.regionBordersDistanceFromCubeCenter / 0.5;
        const yBottomAdjusted = skipCubeOffset ? yBottom : centerY + (yBottom - centerY) * this.regionBordersDistanceFromCubeCenter / 0.5;

        const minZ = -xRightAdjusted;
        const maxZ = -xLeftAdjusted;
        const topIsMaxY = yTopAdjusted > yBottomAdjusted; // is this always true?
        const minY = topIsMaxY ? yBottomAdjusted : yTopAdjusted;
        const maxY = topIsMaxY ? yTopAdjusted : yBottomAdjusted;

        const normalizeZForOverflow = (z: number) => {
            if (this.dimensionOverflow[Dimension.X] && z < -worldSizeX / 2) {
                return z + worldSizeX;
            } 
            return z;
        }

        for (let face = 2; face < 6; face++) {
            if (!faceChanged[face - 2] && !refreshEverything) {
                continue;
            }
            if (!this.faceVisibility[face]) {
                continue;
            }
            const sideLines = this.regionBordersSideLines.get(face)!;
            sideLines.visible = true;
            const intersectingSegments: Vector3[] = [];

            if (face == CubeFace.Left || face == CubeFace.Right) {
                const zCutoff = normalizeZForOverflow(face == CubeFace.Left ? maxZ : minZ);
                const filteredFrontLineIndices = (this.regionBordersFrontActiveLocalParent.userData.lineSegmentMapZ as FastLineSegmentMap).getAllIndicesAtValue(zCutoff);
                for (let i = 0; i < filteredFrontLineIndices.length; i += 2) {
                    const p1index = filteredFrontLineIndices[i] * 3;
                    const p2index = filteredFrontLineIndices[i + 1] * 3;
                    const p1Y = frontLinePositions[p1index + 1];
                    const p1Z = frontLinePositions[p1index + 2];
                    const p2Y = frontLinePositions[p2index + 1];
                    const p2Z = frontLinePositions[p2index + 2];
            
                    // Check if the segment crosses the cutoff plane
                    if ((p1Z < zCutoff && p2Z > zCutoff) || (p1Z > zCutoff && p2Z < zCutoff)) {
                        const t = (zCutoff - p1Z) / (p2Z - p1Z);
                        const intersection = new Vector3(
                            0,
                            p1Y + t * (p2Y - p1Y),
                            zCutoff
                        );
                        if (intersection.y < minY || intersection.y > maxY) {
                            continue;
                        }
                        intersectingSegments.push(intersection);
                    }
                }
            } else {
                const yCutoff = face == CubeFace.Top ? maxY : minY;
                const filteredFrontLineIndices = (this.regionBordersFrontActiveLocalParent.userData.lineSegmentMapY as FastLineSegmentMap).getAllIndicesAtValue(yCutoff);

                for (let i = 0; i < filteredFrontLineIndices.length; i += 2) {
                    const p1index = filteredFrontLineIndices[i] * 3;
                    const p2index = filteredFrontLineIndices[i + 1] * 3;
                    const p1Y = frontLinePositions[p1index + 1];
                    const p2Y = frontLinePositions[p2index + 1];
                    let p1Z = (frontLinePositions[p1index + 2]);
                    let p2Z = (frontLinePositions[p2index + 2]);

                    // Check if the segment crosses the cutoff plane
                    if ((p1Y < yCutoff && p2Y > yCutoff) || (p1Y > yCutoff && p2Y < yCutoff)) {
                        const t = (yCutoff - p1Y) / (p2Y - p1Y);
                        const intersection = new Vector3(
                            0,
                            yCutoff,
                            p1Z + t * (p2Z - p1Z),
                        );

                        if (this.dimensionOverflow[Dimension.X] && intersection.z > maxZ) {
                            intersection.z -= worldSizeX;
                        }

                        if (intersection.z < minZ || intersection.z > maxZ) {
                            continue;
                        }
                        intersectingSegments.push(intersection);
                    }
                }
            }
            
            const positions = sideLines.geometry.attributes.position;
            let lineAmount = positions.count / 2;

            const intersectingAmount = intersectingSegments.length;
            if (intersectingAmount > lineAmount) {
                const newLineAmount = intersectingAmount + 20;
                this.context.log("Increasing side region border line pool from ", lineAmount, "to", newLineAmount);
                const newPositions = this.createRegionBordersSideLinePositions(face, newLineAmount);
                sideLines.geometry.setAttribute('position', new Float32BufferAttribute(newPositions, 3));
                lineAmount = newLineAmount;
            }
            const smallerLimit = Math.min(lineAmount, intersectingAmount);

            if (face == CubeFace.Left || face == CubeFace.Right) {
                for (let i = 0; i < smallerLimit; i++) {
                    const y = this.regionBordersFrontParent.localToWorld(intersectingSegments[i]).y;
                    positions.setY(i * 2, y);
                    positions.setY(i * 2 + 1, y);
                }
            } else {
                for (let i = 0; i < smallerLimit; i++) {
                    const z = this.regionBordersFrontParent.localToWorld(intersectingSegments[i]).z;
                    positions.setZ(i * 2, z);
                    positions.setZ(i * 2 + 1, z);
                }
            }
            const newIndex = range(0, smallerLimit * 2 - 1);
            sideLines.geometry.setIndex(newIndex);
            sideLines.geometry.attributes.position.needsUpdate = true;
            sideLines.geometry.index!.needsUpdate = true;
            
            switch (face) {
                case CubeFace.Top:
                    this.lastSideRegionYTop = yTop;
                    break;
                case CubeFace.Bottom:
                    this.lastSideRegionYBottom = yBottom;
                    break;
                case CubeFace.Left:
                    this.lastSideRegionXLeft = xLeft;
                    break;
                case CubeFace.Right:
                    this.lastSideRegionXRight = xRight;
                    break;
            }
        }
    }

    async updateRegionBorderPositionAndResolution(finalChange: boolean = true) {
        if (!this.regionBordersFrontParent) {
            return;
        }
        if (!this.context.interaction.cubeDimensions.isGeospatialContextValid()) {
            this.regionBordersFrontParent.visible = false;
            this.context.log("Geospatial context not provided, hiding region borders");
            return;
        }
        this.regionBordersFrontParent.visible = true;

        const indexValueLeft = this.context.interaction.cubeSelection.getIndexValueForFace(CubeFace.Left);
        const indexValueRight = this.context.interaction.cubeSelection.getIndexValueForFace(CubeFace.Right);
        const indexValueTop = this.context.interaction.cubeSelection.getIndexValueForFace(CubeFace.Top);
        const indexValueBottom = this.context.interaction.cubeSelection.getIndexValueForFace(CubeFace.Bottom);

        const xTotalRange = this.context.interaction.cubeDimensions.getGeospatialTotalRangeX();
        const yTotalRange = this.context.interaction.cubeDimensions.getGeospatialTotalRangeY();

        const xSelectedRange = this.context.interaction.cubeDimensions.getGeospatialSubRangeX(indexValueLeft, indexValueRight);
        const ySelectedRange = this.context.interaction.cubeDimensions.getGeospatialSubRangeY(indexValueTop, indexValueBottom);

        const selectionCenterPoint = new Vector2(xSelectedRange.middle(), ySelectedRange.middle());
        const selectionSize = new Vector2(xSelectedRange.range(), ySelectedRange.range());
        const datasetCenterPoint = new Vector2(xTotalRange.middle(), yTotalRange.middle());
        const datasetSize = new Vector2(xTotalRange.range(), yTotalRange.range());

        const zoomRelativeToDataset = new Vector2().copy(datasetSize).divide(selectionSize);
        
        const normalizationMatrix = new Matrix4() // normalizes GeoJSON that fits into the dataset bounds to [-0.5, 0.5] x [-0.5, 0.5] 
            .multiply(new Matrix4().makeScale(1, 1 / yTotalRange.range(), 1 / xTotalRange.range()))
            .multiply(new Matrix4().makeTranslation(0, -datasetCenterPoint.y, -datasetCenterPoint.x))

        const finalMatrix = new Matrix4()
            .makeTranslation(
                this.regionBordersDistanceFromCubeCenter * (this.faceVisibility[CubeFace.Back] ? -1 : 1), // move to front or back depending on face visibility 
                -zoomRelativeToDataset.y * (selectionCenterPoint.y - datasetCenterPoint.y) / datasetSize.y, // positive data Y = positive global Y
                zoomRelativeToDataset.x * (selectionCenterPoint.x + datasetCenterPoint.x) / datasetSize.x  // positive data X = negative global Z
            )
            .multiply(new Matrix4().makeScale(1, zoomRelativeToDataset.y, zoomRelativeToDataset.x)) // apply zoom
            .multiply(normalizationMatrix);

        if (this.dimensionOverflow[Dimension.X] && this.regionBordersFrontActiveLocalParent && this.regionBordersFrontActiveLocalParent.children.length > 0) {
            if (!this.regionBordersFrontActiveLocalParent.userData.overflowActive) {
                this.regionBordersFrontActiveLocalParent.userData.activateOverflow();
            }
            const overflowOffsetZ = -datasetSize.x; // this used to be negative for zeroIndexGreenwich data sets, not sure why not anymore
            if (this.regionBordersFrontActiveLocalParent.children[1].position.z != overflowOffsetZ) {
                this.regionBordersFrontActiveLocalParent.children[1].position.setZ(overflowOffsetZ);
            }
        }

        this.regionBordersFrontParent.matrixAutoUpdate = false;
        this.regionBordersFrontParent.matrix.identity();
        this.regionBordersFrontParent.applyMatrix4(finalMatrix);
        this.regionBordersFrontParent.updateMatrixWorld(true); // needs force. alternatively: .matrixWorldNeedsUpdate = true;
        
        this.updateSideRegionBorders(
            xSelectedRange.getFirst(),
            xSelectedRange.getLast(),
            ySelectedRange.getFirst(),
            ySelectedRange.getLast(),
            datasetSize.x
        );

        if (!this.context.widgetMode) {
            if (Math.max(zoomRelativeToDataset.x, zoomRelativeToDataset.y) > 100) {
                // hide region borders since we are all the way zoomed in
            } else {
                const zoomFactor = (zoomRelativeToDataset.x + zoomRelativeToDataset.y) / 2;
                const targetResolution = zoomFactor > 5 ? NaturalEarthRegionBorderResolution.Highest : zoomFactor > 2 ? NaturalEarthRegionBorderResolution.High : NaturalEarthRegionBorderResolution.Default;
                if (this.currentRegionBorderResolution != targetResolution && !this.regionBordersJustLoaded) {
                    await this.loadRegionBorders(targetResolution);
                }
            }
        }

    }

    setCubeLightingEnabled(lightEnabled: boolean = !(this.context.studioMode || this.context.widgetMode)) {
        // front, back, top, bottom, left, right
        const lightStrengths = [ 0.0, 0.0, -0.05, -0.1, -0.15, -0.15 ];
        for (let i = 0; i < 6; i++) {
            this.cube.material[i].uniforms["lightStrength"].value = lightEnabled ? lightStrengths[i] : 0.0;
        }
    }

    getLocalEventPosition(event: Touch | MouseEvent) {
        const brect = this.parent.getBoundingClientRect();
        return new Vector2(event.pageX - brect.left, event.pageY - brect.top);
    }

    getDomElement() {
        return this.renderer.domElement;
    }

    startup() {
        this.animate();
    }
    
    getPercentualFaceVisibility(face: CubeFace) {
        const allPixels = this.faceCurrentPixels.reduce((previous, current, currentIndex) => this.faceVisibility[currentIndex] ? previous + current : previous);
        return this.faceVisibility[face] ? this.faceCurrentPixels[face] / allPixels : 0;
    }
    
    resetForNewParameter() {
        this.totalSizes = new Array<Vector2>();
        this.lods = new Array<number>();
        const dims = this.context.interaction.cubeDimensions;
        const sel = this.context.interaction.cubeSelection;

        const matchTimeScale = document.URL.match(/cubeTimeScale=(\d+\.?\d*)/);
        if (matchTimeScale && matchTimeScale.length > 0) {
            this.cube.scale.set(parseFloat(matchTimeScale[1]), 1, 1);
        }

        for (let face = 0; face < 6; face++) {
            const width = dims.totalWidthForFace(face);
            const height = dims.totalHeightForFace(face);
            this.totalSizes.push(new Vector2(width, height));
            this.lods.push(0);
            this.cube.material[face].uniforms["totalSize"].value = this.totalSizes[face];
            sel.setUniformLocations(face, this.cube.material[face].uniforms["displaySize"], this.cube.material[face].uniforms["displayOffset"])
            this.cube.material[face].uniforms["lod"].value = this.lods[face];
        }
    }

    raycastWindowPosition(mouseX: number, mouseY: number) {
        const x = (mouseX / this.getWidth()) * 2 - 1;
        const y = -(mouseY / this.getHeight()) * 2 + 1;
        return this.raycastNdc(new Vector2(x, y));
    }

    getWidth() {
        if (this.context.widgetMode && !(this.context.interaction && this.context.interaction.fullscreenActive)) {
            return this.widgetModeWidth;
        } else {
            return window.innerWidth;
        }
    }

    getHeight() {
        if (this.context.widgetMode && !(this.context.interaction && this.context.interaction.fullscreenActive)) {
            return this.widgetModeHeight;
        } else {
            return window.innerHeight;
        }
    }

    raycastNdc(ndc: THREE.Vector2) {
        this.rayCaster.setFromCamera(ndc, this.mainCamera);
        return this.rayCaster.intersectObjects([this.cube]);
    }

    private vertexShader() {
        return `
          varying vec2 v_uv;
    
          void main() {
            v_uv = uv; 
      
            vec4 modelViewPosition = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * modelViewPosition; 
          }
        `
    }
      
    private fragmentShader() {
        return `
        precision highp float; 
        precision highp int; 
    
        varying vec2 v_uv;
        uniform highp sampler2DArray tilesLod0;
        uniform highp sampler2DArray tilesLod1;
        uniform highp sampler2DArray tilesLod2;
        uniform highp sampler2DArray tilesLod3;
        uniform highp sampler2DArray tilesLod4;
        uniform highp sampler2DArray tilesLod5;
        uniform highp sampler2DArray tilesLod6;
        
        const float TILE_SIZE = ${TILE_SIZE}.0;
        const float NAN_REPLACEMENT_VALUE = ${NAN_REPLACEMENT_VALUE}.0;
        const float NOT_LOADED_REPLACEMENT_VALUE = ${NOT_LOADED_REPLACEMENT_VALUE}.0;
        uniform vec2 totalSize; // the whole thing, even offscreen stuff
    
        uniform vec2 displaySize; // what is being displayed on the cube, subset of the whole thing
        uniform vec2 displayOffset;
    
        uniform float lightStrength;

        uniform float colormapLowerBound;
        uniform float colormapUpperBound;
        uniform bool colormapFlipped;
        uniform bool hideData;
        uniform bool overflowX;
        uniform bool overflowY;
        uniform sampler2D colormap;

        uniform bool gpsPositionEnabled;
        uniform vec2 gpsPositionRelativeCoordinates; // relative within current totalSize
    
        uniform int lod;

        vec2 positiveModTotalSize(vec2 v) {
            if (overflowX && overflowY) {
                return mod(v + totalSize, totalSize);
            } else if (overflowX) {
                return vec2(mod(v.x + totalSize.x, totalSize.x), v.y);
            } else if (overflowY) {
                return vec2(v.x, mod(v.y + totalSize.y, totalSize.y));
            }
            return v;
        }

        vec2 positiveMod1(vec2 v) {
            if (overflowX && overflowY) {
                return mod(mod(v, 1.0) + vec2(1.0), 1.0);
            } else if (overflowX) {
                return vec2(mod(mod(v.x, 1.0) + 1.0, 1.0), v.y);
            } else if (overflowY) {
                return vec2(v.x, mod(mod(v.y, 1.0) + 1.0, 1.0));
            }
            return v;
        }

        float easeOut(float x) {
            return 1.0 - pow(1.0 - x, 1.5);
        }

        vec3 getGpsPositionColor(float x) {
            vec3 blue = vec3(0.0 / 255.0, 40.0 / 255.0, 68.0 / 255.0);
            vec3 white = vec3(1.0);
            return mix(blue, white, step(0.8, x));
        }

        void main() {
            vec2 display_uv = clamp(positiveMod1(v_uv * displaySize / totalSize + displayOffset / totalSize), vec2(0.0), totalSize - vec2(1.0)); 

            float tile_size_adjusted = TILE_SIZE * pow(2.0, float(lod));
            vec2 total_tiles = totalSize * pow(0.5, float(lod)) / TILE_SIZE;
            vec2 total_tiles_whole = ceil(total_tiles);

            vec2 unclamped_pixel = positiveModTotalSize(displayOffset + clamp(v_uv, vec2(0.00001), vec2(0.99999)) * displaySize); // prevent pixel bleeding artifacts at edges
            vec2 minimum = mix(displayOffset, vec2(0.0), vec2(float(unclamped_pixel.x < displayOffset.x), float(unclamped_pixel.y < displayOffset.y)));
            vec2 maximum = displayOffset + displaySize; // exclusive bound, already next non-visible pixel at this coordinate

            vec2 clamp_border = vec2(0.01); // vec2(0.5) definitely removes all artifacts, vec2(0.01) also seems to remove all artifacts
            vec2 pixel = clamp(unclamped_pixel, minimum + clamp_border, maximum - clamp_border); // prevent pixel bleeding artifacts at edges
    
            vec2 selected_tile = clamp(floor(pixel / tile_size_adjusted), vec2(0.0), total_tiles_whole - vec2(1.0));
            float selected_tile_index = selected_tile.x + selected_tile.y * total_tiles_whole.x;

            vec2 local_tile_uv = (pixel - selected_tile * tile_size_adjusted) / tile_size_adjusted;

            float datavalue = 0.0;
            if (lod == 0) {
                datavalue = (texture(tilesLod0, vec3(local_tile_uv, selected_tile_index))).r;
            } else if (lod == 1) {
                datavalue = (texture(tilesLod1, vec3(local_tile_uv, selected_tile_index))).r;
            } else if (lod == 2) {
                datavalue = (texture(tilesLod2, vec3(local_tile_uv, selected_tile_index))).r;
            } else if (lod == 3) {
                datavalue = (texture(tilesLod3, vec3(local_tile_uv, selected_tile_index))).r;
            } else if (lod == 4) {
                datavalue = (texture(tilesLod4, vec3(local_tile_uv, selected_tile_index))).r;
            } else if (lod == 5) {
                datavalue = (texture(tilesLod5, vec3(local_tile_uv, selected_tile_index))).r;
            } else if (lod == 6) {
                datavalue = (texture(tilesLod6, vec3(local_tile_uv, selected_tile_index))).r;
            }

            float p = clamp((datavalue - colormapLowerBound) / (colormapUpperBound - colormapLowerBound), 0.0, 1.0);
            p = mix(p, 1.0 - p, float(colormapFlipped));
            float checkerboard = float(int(floor(10.0*(local_tile_uv.x)) + floor(10.0*(local_tile_uv.y))) % 2) * 0.2 + 0.4;
            vec3 colormapped = mix(mix(texture(colormap, vec2(p, 0.0)).rgb, vec3(0.2), float(datavalue == NAN_REPLACEMENT_VALUE)), vec3(checkerboard), float(datavalue == NOT_LOADED_REPLACEMENT_VALUE || hideData));

            // GPS position
            vec2 pointSize = (${window.innerWidth > 900 ? 0.03 : 0.06} * displaySize) / totalSize; 
            float d = max(0.0, 1.0 - length(abs(display_uv - gpsPositionRelativeCoordinates) / pointSize));
            vec4 addedGpsPositionColor = mix(vec4(0.0), vec4(d * getGpsPositionColor(d), d), float(gpsPositionEnabled));

            gl_FragColor = vec4(addedGpsPositionColor.rgb + vec3(lightStrength) + mix(colormapped, vec3(0.0), easeOut(addedGpsPositionColor.a)), 1.0);
        }
    `
    }

    onWindowResize() {
        if (this.printTemplateDownloading) {
            return;
        }
        if (this.context.isometricMode) {
            this.updateOrthographicCamera();
        } else {
           (this.mainCamera as any).aspect = this.getWidth() / this.getHeight();
        }
        this.mainCamera.updateProjectionMatrix();
        this.renderer.setSize(this.getWidth(), this.getHeight());
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.context.interaction.updateLabelPositions();
        this.requestRender();
    }
    
    private newCubeMaterial() {
        const newDummyData = () => {
            return new Float32Array(1);
        }
        const newDummyTexture = () => {
            const b = new DataArrayTexture(newDummyData());
            b.type = FloatType;
            b.format = RedFormat;
            return b;
        }
        return new ShaderMaterial( {
            uniforms: {
                tilesLod0: { value: newDummyTexture() },
                tilesLod1: { value: newDummyTexture() },
                tilesLod2: { value: newDummyTexture() },
                tilesLod3: { value: newDummyTexture() },
                tilesLod4: { value: newDummyTexture() },
                tilesLod5: { value: newDummyTexture() },
                tilesLod6: { value: newDummyTexture() },
                lod: { value: 0 },
                displaySize : { value: new Vector2() },
                displayOffset : { value: new Vector2() },
                totalSize : { value: new Vector2() },
                lightStrength: { value: 0.0 },
                colormapLowerBound : { value: 0.0 },
                colormapUpperBound : { value: 0.0 },
                overflowX : { value: false },
                overflowY : { value: false },
                colormapFlipped : { value: false },
                hideData : { value: true },
                colormap : { value: new DataTexture(this.colormapData, this.colormapData.length / 4, 1, RGBAFormat) },
                gpsPositionEnabled : { value: false },
                gpsPositionRelativeCoordinates: { value: new Vector2() }
            },
    
            vertexShader: this.vertexShader(),
            fragmentShader: this.fragmentShader()
        } );
    }

    updateGpsPosition(relativeLatitude: number, relativeLongitude: number) {
        this.cube.material[0].uniforms["gpsPositionRelativeCoordinates"].value = new Vector2(relativeLongitude, relativeLatitude);
        this.cube.material[0].uniforms["gpsPositionEnabled"].value = true;
        this.requestRender();
    }
    
    disableGpsPosition() {
        this.cube.material[0].uniforms["gpsPositionEnabled"].value = false;
    }

    updateColormapOptions(newLowerBound: number, newUpperBound: number, flipped: boolean) {
        for (let face = 0; face < 6; face++) {
            this.cube.material[face].uniforms["colormapLowerBound"].value = newLowerBound;
            this.cube.material[face].uniforms["colormapUpperBound"].value = newUpperBound;
            this.cube.material[face].uniforms["colormapFlipped"].value = flipped;
        }
    }

    updateColormapTexture(newColormap: Uint8Array) {
        this.colormapData.set(newColormap);
        for (let face = 0; face < 6; face++) {
            this.cube.material[face].uniforms["colormap"].value.needsUpdate = true;
        }
    }

    requestRender() {
        this.renderRequested = true;
        if (this.context.interaction) {
            this.context.interaction.resetRenderedAfterAllTilesDownloaded();
        }
    }
    
    private animate() {
        requestAnimationFrame(this.animate.bind(this));

        if (this.maxRangeIndicatorAnimationsPlaying) {
            const delta = this.animationClock.getDelta();
            for (let i = 0; i < this.maxRangeIndicatorAnimationMixers.length; i++) {
                this.maxRangeIndicatorAnimationMixers[i].update(delta);
            }
            this.maxRangeIndicatorAnimationsPlaying = this.maxRangeIndicatorAnimationActions.some((action) => {
                return action.isRunning();
            });
            this.updateMaxRangeIndicatorPositionAndScale();
            this.renderRequested = true;
        }
    
        if (this.renderRequested) {
            this.renderRequested = false;
            this.render();
        }
    }

    getCurrentCamera() {
        return this.printTemplateDownloading ? this.printTemplateCamera : this.mainCamera;
    }

    private render() {
        this.renderer.render(this.scene, this.getCurrentCamera());;
        if (this.allTilesDownloaded) {
            this.allTilesDownloaded = false;
            this.context.interaction.setRenderedAfterAllTilesDownloaded();
        }
    }
    
    private createUvDebugTexture(width: number, height: number) {
        const size = width * height;
        const texture_data = new Uint8Array( 3 * size );
    
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (y * width + x)
                const stride = index * 3;
        
                texture_data[stride]     = 255.0 * (x) / (width); // r
                texture_data[stride + 1] = 255.0 * (y) / (height); // g
                texture_data[stride + 2] = 0.0; // b
            }
        }
    
        const texture = new DataTexture( texture_data, width, height, RGBFormat );
        texture.flipY = true;
        return texture
    }
    
    private getVertexCoordinatesFromFace(face: CubeFace): Vector3[] {
        let pos = this.cube.geometry.attributes.position;
        const resultArray = [];
        const offset = face * 4;
        for (let i = 0; i < 4; i++) {
            const vertexIndex = i + offset;
            const vertexLocal = new Vector3(pos.getX(vertexIndex), pos.getY(vertexIndex), pos.getZ(vertexIndex));
            const vertexGlobal = this.cube.localToWorld(vertexLocal);
            resultArray.push(vertexGlobal);
            // if (this.renderDebugCubes && face == CubeFace.Left) {
            //     this.debugCubes[i].position.copy(vertexGlobal);
            // }
        }
        return resultArray;
    }

    private getEdgesFromFace(face: CubeFace) {
        if (face == CubeFace.Front) {
            let front = this.getVertexCoordinatesFromFace(CubeFace.Front);
            return [ 
                new Edge(front[0], front[1], Dimension.X),  new Edge(front[2], front[3], Dimension.X), 
                new Edge(front[0], front[2], Dimension.Y),   new Edge(front[1], front[3], Dimension.Y)  
            ];
        } else if (face == CubeFace.Back) {
            let back = this.getVertexCoordinatesFromFace(CubeFace.Back);
            return [ 
                new Edge(back[1], back[0], Dimension.X),    new Edge(back[3], back[2], Dimension.X), 
                new Edge(back[0], back[2], Dimension.Y),     new Edge(back[1], back[3], Dimension.Y)  
            ];
        } else if (face == CubeFace.Top) {
            let top = this.getVertexCoordinatesFromFace(CubeFace.Top);
            return [ 
                new Edge(top[3], top[1], Dimension.X),  new Edge(top[2], top[0], Dimension.X), 
                new Edge(top[0], top[1], Dimension.Z),       new Edge(top[2], top[3], Dimension.Z)  
            ];
        } else if (face == CubeFace.Bottom) {
            let bot = this.getVertexCoordinatesFromFace(CubeFace.Bottom);
            return [ 
                new Edge(bot[1], bot[3], Dimension.X),  new Edge(bot[0], bot[2], Dimension.X), 
                new Edge(bot[0], bot[1], Dimension.Z),       new Edge(bot[2], bot[3], Dimension.Z)  
            ];
        } else if (face == CubeFace.Left) {
            let left = this.getVertexCoordinatesFromFace(CubeFace.Left);
            return [ 
                new Edge(left[1], left[3], Dimension.Y), new Edge(left[0], left[2], Dimension.Y), 
                new Edge(left[0], left[1], Dimension.Z),     new Edge(left[2], left[3], Dimension.Z)  
            ];
        } else {
            let right = this.getVertexCoordinatesFromFace(CubeFace.Right);
            return [ 
                new Edge(right[1], right[3], Dimension.Y),   new Edge(right[0], right[2], Dimension.Y), 
                new Edge(right[1], right[0], Dimension.Z),       new Edge(right[3], right[2], Dimension.Z)  
            ];
        }     
    }

    private getEdgesFromDimension(dimension: Dimension) {
        if (dimension == Dimension.X) {
            let front = this.getVertexCoordinatesFromFace(CubeFace.Front);
            let back = this.getVertexCoordinatesFromFace(CubeFace.Back);
            return [
                new Edge(front[0], front[1], Dimension.X), 
                new Edge(front[2], front[3], Dimension.X), 
                new Edge(back[1], back[0], Dimension.X), 
                new Edge(back[3], back[2], Dimension.X)
            ]
        } else if (dimension == Dimension.Y) {
            let front = this.getVertexCoordinatesFromFace(CubeFace.Front);
            let back = this.getVertexCoordinatesFromFace(CubeFace.Back);
            return [
                new Edge(front[0], front[2], Dimension.Y),
                new Edge(front[1], front[3], Dimension.Y),
                new Edge(back[0], back[2], Dimension.Y),
                new Edge(back[1], back[3], Dimension.Y)
            ]
        } else { // dimension == Dimension.Time
            let left = this.getVertexCoordinatesFromFace(CubeFace.Left);
            let right = this.getVertexCoordinatesFromFace(CubeFace.Right);
            return [
                new Edge(left[0], left[1], Dimension.Z),
                new Edge(left[2], left[3], Dimension.Z),
                new Edge(right[0], right[1], Dimension.Z),
                new Edge(right[2], right[3], Dimension.Z)
            ]
        }
    }

    private calculateLabelScreenPosition(startPoint: Vector3, edge: Edge) {
        const minimumLabelDistanceInWindowPixels = 40;
        const labelDirection = edge.getDirection();
        const labelStartScreenPosition = this.getScreenCoordinatesFromWorldPosition(startPoint);
        const labelEndScreenPosition = this.getScreenCoordinatesFromWorldPosition(startPoint.clone().addScaledVector(labelDirection, 0.1));

        const directionScreen = new Vector2(labelEndScreenPosition.x - labelStartScreenPosition.x, labelEndScreenPosition.y - labelStartScreenPosition.y);
        directionScreen.setLength(Math.min(minimumLabelDistanceInWindowPixels, directionScreen.length()));
        const positionScreen = directionScreen.clone().add(new Vector2(labelStartScreenPosition.x, labelStartScreenPosition.y));
        const angle = directionScreen.angle() / Math.PI; // [0-2]
        return { angle, positionScreen }
    }

    getLabelPositions() {
        let allEdges: Edge[] = [];
        for (let face = 0; face < 6; face++) {
            if (this.faceVisibility[face]) {
                const e = this.getEdgesFromFace(face);
                allEdges.push(...e);
            }
        }

        const contourEdges: Edge[] = [];

        for (let e of allEdges) {
            let sharesP1With = 0;
            let sharesP2With = 0;
            for (let f of allEdges) {
                if (e != f) {
                    if (e.sharesP1With(f)) {
                        sharesP1With += 1;
                    }
                    if (e.sharesP2With(f)) {
                        sharesP2With += 1;
                    }
                }
            }
            if (sharesP1With == 1 || sharesP2With == 1) {
                contourEdges.push(e);
            }
        }

        let dimensionsToLabel = [...new Set(contourEdges.map(v => v.dimension))];

        const visibilityThreshold = 0.1; // 10% of all cube pixels need to part of a face depending on the to be labeled dimension for it to be visible

        dimensionsToLabel = dimensionsToLabel.filter(dimension => {
            let faces = getAddressedFacesOfDimension(dimension);
            let total = faces.map(v => this.getPercentualFaceVisibility(v)).reduce((u, v) => u + v);
            return total > visibilityThreshold;
        });

        let labelDirectionDimensions: Dimension[] = [0, 0, 0];

        for (let dimension of dimensionsToLabel) {
            const dominantFace = this.getVisuallyDominantFace();
   
            if (dimension == Dimension.X) {
                labelDirectionDimensions[dimension] = (dominantFace == CubeFace.Front || dominantFace == CubeFace.Back) ? Dimension.Y : Dimension.Z;
            } else if (dimension == Dimension.Y) {
                if (dominantFace == CubeFace.Top || dominantFace == CubeFace.Bottom) {
                    const chooseLon = Math.abs(Math.round((this.mainCamera.rotation.z / Math.PI) * 2)) % 2 == 1;
                    labelDirectionDimensions[dimension] = chooseLon ? Dimension.X : Dimension.Z;
                } else {
                    labelDirectionDimensions[dimension] = (dominantFace == CubeFace.Front || dominantFace == CubeFace.Back) ? Dimension.X : Dimension.Z;
                }
            } else if (dimension == Dimension.Z) {
                labelDirectionDimensions[dimension] = (dominantFace == CubeFace.Left || dominantFace == CubeFace.Right) ? Dimension.Y : Dimension.X; 
            }
        }
        
        const blockedEdges: Edge[] = [];
        let foundEdge = false;
        const result: LabelPositionResult[] = [new LabelPositionResult(), new LabelPositionResult(), new LabelPositionResult()];
        for (let dimension of dimensionsToLabel) {
            const labelDirectionDimension = labelDirectionDimensions[dimension];

            
            const labelEdgesWorld = contourEdges.filter(e => e.dimension == dimension)!;
            labelEdgesWorld.sort((a, b) => this.getScreenCoordinatesFromWorldPosition(a.middle()).z - this.getScreenCoordinatesFromWorldPosition(b.middle()).z )
            if (this.lastLabelEdges[dimension] !== undefined) {
                const lastEdge = this.lastLabelEdges[dimension]!;
                if (lastEdge.equals(labelEdgesWorld[1])) {
                    labelEdgesWorld.reverse(); // prefer old label edge
                }
            }
            let minDirectionEdgeWorld: Edge, maxDirectionEdgeWorld: Edge, labelEdgeWorld: Edge;
            for (let i = 0; i < labelEdgesWorld.length; i++) {
                labelEdgeWorld = labelEdgesWorld[i];
                minDirectionEdgeWorld = this.getEdgesFromDimension(labelDirectionDimension).find(
                    (directionEdge) => directionEdge.p1.equals(labelEdgeWorld.p1) || directionEdge.p2.equals(labelEdgeWorld.p1)
                )!.clone();
                if (minDirectionEdgeWorld.p1.equals(labelEdgeWorld.p1)) {
                    minDirectionEdgeWorld.reverse();
                }
                maxDirectionEdgeWorld = this.getEdgesFromDimension(labelDirectionDimension).find(
                    (directionEdge) => directionEdge.p1.equals(labelEdgeWorld.p2) || directionEdge.p2.equals(labelEdgeWorld.p2)
                )!.clone();
                if (maxDirectionEdgeWorld.p1.equals(labelEdgeWorld.p2)) {
                    maxDirectionEdgeWorld.reverse();
                }
                const blocked = !!(blockedEdges.find((v) => v.isIdenticalLine(minDirectionEdgeWorld))) || !!(blockedEdges.find((v) => v.isIdenticalLine(maxDirectionEdgeWorld)));
                if (!blocked) {
                    foundEdge = true;
                    blockedEdges.push(minDirectionEdgeWorld);
                    blockedEdges.push(maxDirectionEdgeWorld);
                    this.lastLabelEdges[dimension] = labelEdgeWorld;
                    break;
                }
            }
            if (minDirectionEdgeWorld! === undefined || maxDirectionEdgeWorld! === undefined || labelEdgeWorld! === undefined || !foundEdge) {
                console.warn(`Did not find edge for labeling dimension ${dimension}`)
                return result;
            }

            const minInfo = this.calculateLabelScreenPosition(labelEdgeWorld.p1, minDirectionEdgeWorld);
            const maxInfo = this.calculateLabelScreenPosition(labelEdgeWorld.p2, maxDirectionEdgeWorld);
            const nameInfo = this.calculateLabelScreenPosition(new Vector3().lerpVectors(labelEdgeWorld.p1, labelEdgeWorld.p2, 0.5), maxDirectionEdgeWorld.lerpedWith(minDirectionEdgeWorld));

            result[dimension] =  { 
                visible: true,
                screenPositionMinLabel: minInfo.positionScreen,
                screenPositionMaxLabel: maxInfo.positionScreen,
                screenPositionNameLabel: nameInfo.positionScreen,
                angleMinLabel: minInfo.angle,
                angleMaxLabel: maxInfo.angle,
                angleNameLabel: nameInfo.angle
            };
        }
        return result;
    }
    
    private getScreenCoordinatesFromWorldPosition(worldPosition: Vector3): Vector3 {
        // this.camera.updateMatrixWorld(); // fixes jittering issue, but done in OrbitControls now instead
        let result = worldPosition.clone().project(this.getCurrentCamera());
        let widthHalf = this.getWidth() / 2;
        let heightHalf = this.getHeight() / 2;
        
        const result_x = (result.x * widthHalf) + widthHalf;
        const result_y = -(result.y * heightHalf) + heightHalf;

        // returns correct coordinates in body pixel space (i.e. DPI is already factored in, 1 pixel in body space is 1 or more display pixels)
        return new Vector3(result_x, result_y , result.z);
    }
    
    hideData() {
        for (let face = 0; face < 6; face++) {
            this.cube.material[face].uniforms["hideData"].value = true;
        }
    }

    showDataForFace(face: CubeFace) {
        this.cube.material[face].uniforms["hideData"].value = false;
    }

    private getVisuallyDominantFace() {
        const b = this.mainCamera.position.toArray().map(a => Math.abs(a));
        const max = Math.max(...b);
        if (max == Math.abs(this.mainCamera.position.x)) {
            return Math.sign(this.mainCamera.position.x) > 0 ? CubeFace.Front : CubeFace.Back;
        }
        if (max == Math.abs(this.mainCamera.position.y)) {
            return Math.sign(this.mainCamera.position.y) > 0 ? CubeFace.Top : CubeFace.Bottom;
        }
        return Math.sign(this.mainCamera.position.z) > 0 ? CubeFace.Left : CubeFace.Right;
    }

    private updateLodForFace(face: CubeFace, allowEarlyRefresh: boolean = true) {
        const verticesGlobal = this.getVertexCoordinatesFromFace(face);
        const verticesScreen = verticesGlobal.map((worldPosition) => this.getScreenCoordinatesFromWorldPosition(worldPosition));
        verticesScreen.forEach(p => p.setZ(0));
    
        const firstHalf = new Triangle(verticesScreen[0], verticesScreen[1], verticesScreen[2]);
        const secondHalf = new Triangle(verticesScreen[1], verticesScreen[2], verticesScreen[3]);
        const onScreenPixels = (firstHalf.getArea() + secondHalf.getArea()) * Math.pow(devicePixelRatio, 2);
        this.faceCurrentPixels[face] = onScreenPixels;
    
        const cubeEdgeLength = this.displayQuality * Math.sqrt(onScreenPixels);
    
        const dataSize = this.context.interaction.cubeSelection.getSizeVector(face);
        const dataPixelAmount = dataSize.x * dataSize.y;
        const dataEdgeLength = Math.sqrt(dataPixelAmount);
        const edgeRatio = Math.log2(dataEdgeLength / cubeEdgeLength);
        const lod = clamp(Math.round(edgeRatio), 0, this.context.interaction.selectedCubeMetadata.max_lod);
    
        if (lod != this.lods[face]) {
            this.context.log(`[${CubeFace[face]}] New lod level: ${lod} (previously ${this.lods[face]})`);
            const earlyRefresh = lod > this.lods[face];
            this.lods[face] = lod;
            if (earlyRefresh && allowEarlyRefresh) {
                this.revealLodForFace(face);
            }
        }
    }
    
    private updateVisibilityForFace(face: CubeFace) {
        // if (this.context.studioMode) {
        //     return this.faceVisibility[face] = face != CubeFace.Back;
        // }
        const camera = this.getCurrentCamera();
        let visible = 
            (face == CubeFace.Front  && camera.position.x >  0.5) ||
            (face == CubeFace.Back   && camera.position.x < -0.5) ||
            (face == CubeFace.Top    && camera.position.y >  0.5) ||
            (face == CubeFace.Bottom && camera.position.y < -0.5) ||
            (face == CubeFace.Left   && camera.position.z >  0.5) ||
            (face == CubeFace.Right  && camera.position.z < -0.5);
        
        if (this.faceVisibility[face] != visible) {
            this.context.log(`[${CubeFace[face]}] Visible: ${visible} (previously: ${this.faceVisibility[face]})`)
            this.faceVisibility[face] = visible;
            this.updateRegionBorderPositionAndResolution(); 
        }
    }

    updateVisibilityAndLodsWithoutTriggeringDownloads() {
        if (typeof this.context.interaction.cubeSelection === "undefined" || !this.context.interaction.fullyLoaded) {
            return;
        }
        for (let face = 0; face < 6; face++) {
            this.updateVisibilityForFace(face);
            if (this.faceVisibility[face]) {
                this.updateLodForFace(face, false);
            }
        }
    }

    updateVisibilityAndLodsDebounced(): void {
        if (this.debouncedVisibilityAndLodUpdateTimeoutHandler) {
            window.clearTimeout(this.debouncedVisibilityAndLodUpdateTimeoutHandler);
        }
        this.debouncedVisibilityAndLodUpdateTimeoutHandler = window.setTimeout(() => { 
            this.updateVisibilityAndLods();
            this.debouncedVisibilityAndLodUpdateTimeoutHandler = 0;
        }, 100);
    }

    updateVisibilityAndLods() {
        if (typeof this.context.interaction.cubeSelection === "undefined" || !this.context.interaction.fullyLoaded) {
            return;
        }
        for (let face = 0; face < 6; face++) {
            this.updateVisibilityForFace(face);
            if (this.faceVisibility[face]) {
                this.updateLodForFace(face);
            }
        }
        this.context.interaction.triggerTileDownloads();
    }

    startDownloadPrintTemplate() {
        if (this.printTemplateDownloading) {
            return;
        }
        this.setCubeLightingEnabled(false);
        this.context.interaction.showPrintTemplateLoader()
        this.context.log("Start downloading print template");
        this.renderer.setSize(2048, 2048);
        // const forcedAspect = 1;
        // if (this.context.isometricMode) {
        //     this.updateOrthographicCamera(forcedAspect);
        // } else {
        //    (this.camera as any).aspect = forcedAspect;
        // }
        // this.camera.updateProjectionMatrix();
        this.renderer.setPixelRatio(1);

        this.printTemplateCurrentFace = -1;
        this.printTemplateDownloading = true;
        this.printTemplateResults = [];
        this.downloadScreenshotAsDataUrl(); // fixes issue on some devices that the first screenshot download fails
        this.processNextFaceForPrintTemplate();
    }

    private updateOrthographicCamera(aspectOverride: number | undefined = undefined) {
        const minimumVisibleInWorldUnits = 2.2;
        const aspect = aspectOverride || this.getWidth() / this.getHeight();
        const height = aspect > 1 ? minimumVisibleInWorldUnits : minimumVisibleInWorldUnits / aspect;
        const width = aspect > 1 ? aspect * minimumVisibleInWorldUnits : minimumVisibleInWorldUnits;
        (this.mainCamera as OrthographicCamera).left = width / -2;
        (this.mainCamera as OrthographicCamera).right = width / 2;
        (this.mainCamera as OrthographicCamera).top = height / 2;
        (this.mainCamera as OrthographicCamera).bottom = height / -2;
        this.mainCamera.updateProjectionMatrix();
    }

    async processNextFaceForPrintTemplate() {
        if (this.printTemplateCurrentFace !== -1) {
            this.printTemplateResults.push(this.downloadScreenshotAsDataUrl()); 
            this.context.log("Finished face", CubeFace[this.printTemplateCurrentFace], this.printTemplateResults[this.printTemplateResults.length - 1].length);
        }
        this.printTemplateCurrentFace += 1;
        if (this.printTemplateCurrentFace >= 6) {
            this.finishDownloadPrintTemplate();
            return;
        }
        this.context.interaction.applyCameraPreset(`Single Face (${CubeFace[this.printTemplateCurrentFace]})`, this.printTemplateCamera);
        this.updateVisibilityAndLods();
        await this.updateRegionBorderPositionAndResolution();
        this.requestRender();
    }

    private printTemplateJustDownloaded = false;

    async finishDownloadPrintTemplate() {
        this.printTemplateDownloading = false;
        this.printTemplateJustDownloaded = true;
        // this.context.interaction.applyCameraPreset();
        this.onWindowResize();
        this.setCubeLightingEnabled();
        this.updateVisibilityAndLods();
        this.context.interaction.updateLabelPositions();
        this.requestRender();
        this.context.log("Reset camera & renderer, now generating print template", this.printTemplateResults.length);
        let svg = await this.context.interaction.getPrintTemplateSvg();
        this.context.log("Got svg template", svg.length, svg.substring(0, 100));
        for (let i = 0; i < 6; i++) {
            svg = svg.replace(`current/${CubeFace[i].toLowerCase()}.png`, this.printTemplateResults[i]);
        }
        this.context.interaction.showPrintTemplateResult(svg);
        this.printTemplateJustDownloaded = false;
    }
    
    private getFilterFunctionForScreenshotsAndRecordings(includeUi: boolean) {
        const includedClasses = includeUi ? this.htmlClassesOptionalForScreenshots.concat(this.htmlClassesAlwaysInScreenshots) : this.htmlClassesAlwaysInScreenshots;
        const positiveFilter = (node: HTMLElement) => {
            let visible = false;
            let current = node;
            while (current != null) {
                if (this.htmlClassesNeverInScreenshots.some((classname) => current.classList?.contains(classname))) {
                    return false;
                }
                if (includedClasses.some((classname) => current.classList?.contains(classname))) {
                    visible = true;
                    break;
                }
                current = current.parentElement!;
            }
            return node.tagName === "CANVAS" || visible;
        }
        return positiveFilter;
    }

    async downloadScreenshotFromUi(includeUi: boolean, filename: string = "", dpiscale: number = 1) {
        if (dpiscale != 1) {
            this.renderer.setPixelRatio(window.devicePixelRatio * dpiscale);
            this.render();
        }
        let dataUrl = "";
        const positiveFilter = this.getFilterFunctionForScreenshotsAndRecordings(includeUi);
        if (!this.screenshotFontEmbedCss) {
            this.screenshotFontEmbedCss = await getFontEmbedCSS(this.parent);
        }
        try {
            dataUrl = await toPng(this.parent, { 
                "filter": positiveFilter, 
                pixelRatio: window.devicePixelRatio * dpiscale, 
                style: { backgroundColor: "transparent" }, 
                fontEmbedCSS: this.screenshotFontEmbedCss
            });
        } catch (e) {
            console.error("Error during screenshot generation", e);
            return;
        }
        let a = document.createElement('a');
        a.href = dataUrl;
        a.download = filename || `${this.getDownloadFileName()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        if (dpiscale != 1) {
            this.renderer.setPixelRatio(window.devicePixelRatio);
            this.render();
        }
    }

    downloadScreenshotAsDataUrl() {
        return this.renderer.domElement.toDataURL("image/png"); // works only if this.renderer.render() was just called
    }
    
    revealLodForFace(face: CubeFace) {
        this.cube.material[face].uniforms["lod"].value = this.lods[face];
    }

    getCurrentlyShownLodForFace(face: CubeFace) {
        return this.cube.material[face].uniforms["lod"].value;
    }
    
    dataShown() {
        return this.cube.material[5].uniforms["hideData"].value == false;
    }
    
    setAllTilesDownloaded() {
        this.allTilesDownloaded = true;
    }

    updateOverflowSettings(overflowX: boolean, overflowY: boolean, overflowZ: boolean, allowWidgetUpdate: boolean = true) {
        this.dimensionOverflow = [overflowX, overflowY, overflowZ];
        for (let face = 0; face < 6; face++) {
            this.cube.material[face].uniforms["overflowX"].value = face < 4 ? overflowX : overflowY;
            this.cube.material[face].uniforms["overflowY"].value = face < 2 ? overflowY : overflowZ;
        }
        if (this.context.widgetMode && allowWidgetUpdate) {
            this.updateWidgetModelDimensionWrapSettings(overflowX, overflowY, overflowZ)
        }
    }

    private getDownloadFileName(affix: string = "") {
        const cubeName = this.context.interaction.selectedCube.id !== "default" ? `${this.context.interaction.selectedCube.id}-` : "";
        const parameterName = this.context.interaction.selectedParameterId !== "default_var" ? `${this.context.interaction.selectedParameterId}-` : "";
        return `lexcube-${affix}${cubeName}${parameterName}${new Date().toLocaleDateString()}-${new Date().toLocaleTimeString()}`;
    }

    startRecordingAnimation(fps: number) {
        try {
            this.context.log("Start recording animation");
            const canvas = this.renderer.domElement;
            const Recorder = this.recordingFileFormat == RecordingFileFormat.GIF ? FixedFrameGifCanvasRecorder : FixedFrameVideoEncoderCanvasRecorder;
            this.canvasRecorder = new Recorder(this.parent, canvas, this.getFilterFunctionForScreenshotsAndRecordings(true), this.recordingFileFormat!, fps);
            this.canvasRecorder.startCapture(this.context.log.bind(this.context), this.getDownloadFileName("animation-"));
            this.recordingAnimation = true;
        } catch (e: unknown) {
            window.alert("Your browser does not support recording videos. Please try a different browser.");
            console.error("Error when starting animation recording", e);
        }
    }
    
    async stopRecordingAnimation() {
        if (!this.recordingAnimation) {
            this.context.interaction.resetAnimationRecordingUiPostDownload(); // just in case
            return;
        }
        this.recordingAnimation = false;
        await this.canvasRecorder?.requestFinishCapture(() => {
                this.context.interaction.resetAnimationRecordingUiPostDownload();
            }
        );
    }

    async captureRecordingFrame(lastFrame: boolean = false) {
        if (this.recordingAnimation) {
            await this.canvasRecorder?.recordFrame(lastFrame);
        }
    }

    setAnimationRecordingFormat(value: string) {
        this.recordingFileFormat = RecordingFileFormat[value as keyof typeof RecordingFileFormat];
    }
    
    adjustCameraPresetToCube(position: Vector3) {
        if (this.mainCamera instanceof OrthographicCamera) {
            return;
        }

        this.mainCamera.updateMatrixWorld();
        const realMaxCanvasSize = Math.min(this.getWidth(), this.getHeight() + 300); // height is less important for UI etc.
        const extraPaddingForSmallCanvas = lerp(0.2, 0, (realMaxCanvasSize - 400) / 600); // 400px = +0.2, 700px = +0.1, 1000px = +0.0
        const paddingWorldUnits = 0.1 + Math.max(0, extraPaddingForSmallCanvas); // in world units
        const halfSize = 0.5 + paddingWorldUnits;

        const corners = [
            new Vector3(-halfSize, -halfSize, -halfSize),
            new Vector3(-halfSize, -halfSize, halfSize),
            new Vector3(-halfSize, halfSize, -halfSize),
            new Vector3(-halfSize, halfSize, halfSize),
            new Vector3(halfSize, -halfSize, -halfSize),
            new Vector3(halfSize, -halfSize, halfSize),
            new Vector3(halfSize, halfSize, -halfSize),
            new Vector3(halfSize, halfSize, halfSize)
        ];

        // Convert FOV to radians
        const fovRad = this.mainCamera.fov * (Math.PI / 180);
        const halfFovRad = fovRad / 2;
        const cameraDirection = new Vector3().copy(position).normalize();
        
        // Calculate the required distance for each corner
        let maxDistance = 0;
        
        for (const corner of corners) {
            // Project the corner onto the camera direction to find distance along camera axis
            const projectionLength = corner.dot(cameraDirection);
            
            // Calculate the perpendicular distance from the corner to the camera axis
            const perpendicularVector = corner.clone().sub(cameraDirection.clone().multiplyScalar(projectionLength));
            const perpendicularDistance = perpendicularVector.length();
            
            // Calculate required distance for this corner to be visible
            // For vertical dimension
            let verticalDistance = perpendicularDistance / Math.tan(halfFovRad);
            
            // For horizontal dimension, adjust for aspect ratio
            let horizontalDistance = perpendicularDistance / (Math.tan(halfFovRad) * this.mainCamera.aspect);
            
            // Use the larger of the two distances
            const cornerDistance = Math.max(verticalDistance, horizontalDistance);
            
            // Add the projection length to get the total distance needed
            const totalDistance = cornerDistance + projectionLength;
            
            // Keep track of the maximum distance needed
            maxDistance = Math.max(maxDistance, totalDistance);
        }
        
        // Position the camera at the calculated distance
        position.setLength(maxDistance);
    }
    
    setWidgetSize(width: number, height: number) {
        this.parent.style.width = `${width}px`;
        this.parent.style.height = `${height}px`;
        this.widgetModeWidth = width;
        this.widgetModeHeight = height;
        this.onWindowResize();
    }
}


export { CubeRendering }