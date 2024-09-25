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

import { AmbientLight, BoxGeometry, DataTexture, DataArrayTexture, DirectionalLight, FloatType, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, Raycaster, RedFormat, RGBAFormat, RGBFormat, Scene, ShaderMaterial, Triangle, Vector2, Vector3, WebGLRenderer } from 'three'
import { clamp } from 'three/src/math/MathUtils';
import { toPng } from 'html-to-image';
import { COLORMAP_STEPS, CubeFace, DEFAULT_WIDGET_HEIGHT, DEFAULT_WIDGET_WIDTH, Dimension, getAddressedFacesOfDimension, getFacesOfIndexDimension, NAN_REPLACEMENT_VALUE, NOT_LOADED_REPLACEMENT_VALUE, TILE_SIZE } from './constants';
import { CubeClientContext } from './client';


class LabelPositionResult {
    visible: boolean = false;
    screenPositionMinLabel!: Vector2;
    screenPositionMaxLabel!: Vector2; 
    screenPositionNameLabel!: Vector2; 
    angleMinLabel!: number; 
    angleMaxLabel!: number; 
    angleNameLabel!: number; 
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
    camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
    private scene: THREE.Scene;
    cube: THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial[]>;
    
    displayQuality = 1.0;
    
    private totalSizes: Vector2[];
    lods: number[];
    faceVisibility: Array<boolean> = new Array<boolean>(false, false, false, false, false, false);
    private faceCurrentPixels: number[] = [0,0,0,0,0,0];
    private rayCaster: Raycaster = new Raycaster();
    private context: CubeClientContext;
    
    private isometricFrustumSize = 2.2;
    
    private colormapData: Uint8Array;
    renderDebugCubes: boolean;
    debugCubes: THREE.Mesh[];
    private allTilesDownloaded: boolean = false;
    private parent: HTMLElement;

    private renderNeeded: boolean = true;

    updateWidgetDimensionWrapSettings: (xWrap: boolean, yWrap: boolean, zWrap: boolean) => void = () => {};

    constructor(context: CubeClientContext, parent: HTMLElement) {
        this.context = context;
        this.parent = parent;
        this.colormapData = new Uint8Array(COLORMAP_STEPS * 4);
        this.colormapData.fill(128);

        this.totalSizes = new Array<Vector2>();
        this.lods = new Array<number>();

        this.scene = new Scene()
            
        if (context.isometricMode) {
            const aspect = this.getWidth() / this.getHeight();
            this.camera = new OrthographicCamera(this.isometricFrustumSize * aspect / - 2, this.isometricFrustumSize * aspect / 2, this.isometricFrustumSize / 2, this.isometricFrustumSize / - 2, 0.1, 100);
            this.camera.position.setFromSphericalCoords( 
                4, 
                Math.PI / 3, // 60 degrees from positive Y-axis and 30 degrees to XZ-plane
                Math.PI / 4  // 45 degrees, between positive X and Z axes, thus on XZ-plane
            );
        } else {
            let fov = 50;
            const matchFov = document.URL.match(/fov=(\d+\.?\d*)/);
            if (matchFov && matchFov.length > 0) {
                fov = parseInt(matchFov[1]);
            }
            this.camera = new PerspectiveCamera(fov, this.getWidth() / this.getHeight(), 0.01, 100);
        }
    
        const frontLight = new DirectionalLight("white", 0.4)
        frontLight.position.set(1.0, 1.4, -0.7)
    
        const backLight = new DirectionalLight("white", 0.4)
        backLight.position.set(-1.0, 1.4, 0.7)
    
        const ambientLight = new AmbientLight("white", 0.6);
    
        this.renderer = new WebGLRenderer({ 
            antialias: true, 
            alpha: this.context.studioMode,
            preserveDrawingBuffer: this.context.studioMode 
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
        
        (window as any)["saveCameraPreset"] = () => {
            const s = `{ position: new Vector3(${this.camera.position.x}, ${this.camera.position.y}, ${this.camera.position.z}), rotation: new Euler(${this.camera.rotation.x}, ${this.camera.rotation.y}, ${this.camera.rotation.z}) },`
            console.log(s)
        }
    }

    setCubeLightingEnabled(lightEnabled: boolean = !this.context.studioMode) {
        // front, back, top, bottom, left, right
        const lightStrengths = [ 0.0, 0.0, 0.0, -0.1, -0.15, -0.15 ];
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

        // if (!this.squareCube) {
        //     // outdated, should use parameter range instead
        //     const minDimension = Math.min(dims.longitudeSteps, dims.timeSteps);
        //     const factor = 0.5 / minDimension;
        //     this.cube.scale.set(sel.getSelectionRangeByDimension(Dimension.Time).length() / sel.getSelectionRangeByDimension(Dimension.Latitude).length(), 1, 1);
        // }    
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
            return DEFAULT_WIDGET_WIDTH;
        } else {
            return window.innerWidth;
        }
    }

    getHeight() {
        if (this.context.widgetMode && !(this.context.interaction && this.context.interaction.fullscreenActive)) {
            return DEFAULT_WIDGET_HEIGHT;
        } else {
            return window.innerHeight;
        }
    }

    raycastNdc(ndc: THREE.Vector2) {
        this.rayCaster.setFromCamera(ndc, this.camera);
        return this.rayCaster.intersectObjects(this.scene.children);
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
            vec2 total_tiles = totalSize * pow(0.5, float(lod)) / TILE_SIZE;
            vec2 total_tiles_whole = ceil(total_tiles);
            vec2 uv_offset = displayOffset / totalSize;
            vec2 display_ratio = displaySize / totalSize;

            // clamp dimensions to never reach 1 - in case of non-256 tiles (edge tiles) prevents flickering NaN values at cube edges
            vec2 display_uv_minimum = 1.0 / totalSize;
            vec2 display_uv_maximum = (totalSize - vec2(3.0)) / totalSize; // 3.0 is for some reason the lowest number where the artifacts disappear
            vec2 display_uv = clamp(positiveMod1(v_uv * display_ratio + uv_offset), display_uv_minimum, display_uv_maximum); 
    
            vec2 selected_tile = clamp(floor(display_uv * total_tiles), vec2(0.0), total_tiles_whole - vec2(1.0));
            float selected_tile_index = selected_tile.x + selected_tile.y * total_tiles_whole.x;
            vec2 local_tile_uv = (display_uv - (selected_tile / total_tiles)) * total_tiles;
            local_tile_uv = floor(local_tile_uv * TILE_SIZE) / TILE_SIZE;
    
            vec4 color = vec4(0.0);
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
            const aspect = this.getWidth() / this.getHeight();
            (this.camera as OrthographicCamera).left = this.isometricFrustumSize * aspect / - 2;
            (this.camera as OrthographicCamera).right = this.isometricFrustumSize * aspect / 2;
            (this.camera as OrthographicCamera).top = this.isometricFrustumSize / 2;
            (this.camera as OrthographicCamera).bottom = this.isometricFrustumSize / - 2;
            this.camera.updateProjectionMatrix();
        } else {
           (this.camera as any).aspect = this.getWidth() / this.getHeight();
            this.camera.updateProjectionMatrix();
        }
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
        this.renderNeeded = true;
        this.context.interaction.resetRenderedAfterAllTilesDownloaded();
    }
    
    private animate() {
        requestAnimationFrame(this.animate.bind(this));
    
        if (this.renderNeeded) {
            this.renderNeeded = false;
            this.render();
        }
    }
    
    private render() {
        this.renderer.render(this.scene, this.camera);
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

    private lastLabelEdges: (Edge | undefined)[] = [undefined, undefined, undefined];

    
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
                    const chooseLon = Math.abs(Math.round((this.camera.rotation.z / Math.PI) * 2)) % 2 == 1;
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
                    labelEdgesWorld.reverse();
                    // console.log("preferring old label edge", Dimension[dimension]);
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
        let result = worldPosition.clone().project(this.camera);
        let widthHalf = this.getWidth() / 2;
        let heightHalf = this.getHeight() / 2;
        
        const result_x = (result.x * widthHalf) + widthHalf;
        const result_y = - (result.y * heightHalf) + heightHalf;
        return new Vector3(result_x, result_y, result.z); // returns correct coordinates in body pixel space (i.e. DPI is already factored in, 1 pixel in body space is 1 or more display pixels)
    }
    
    hideData() {
        for (let face = 0; face < 6; face++) {
            this.cube.material[face].uniforms["hideData"].value = true;
        }
    }

    showData() {
        for (let face = 0; face < 6; face++) {
            this.cube.material[face].uniforms["hideData"].value = false;
        }
    }

    showDataForFace(face: CubeFace) {
        this.cube.material[face].uniforms["hideData"].value = false;
    }

    private getVisuallyDominantFace() {
        const b = this.camera.position.toArray().map(a => Math.abs(a));
        const max = Math.max(...b);
        if (max == Math.abs(this.camera.position.x)) {
            return Math.sign(this.camera.position.x) > 0 ? CubeFace.Front : CubeFace.Back;
        }
        if (max == Math.abs(this.camera.position.y)) {
            return Math.sign(this.camera.position.y) > 0 ? CubeFace.Top : CubeFace.Bottom;
        }
        return Math.sign(this.camera.position.z) > 0 ? CubeFace.Left : CubeFace.Right;
    }

    private updateLodForFace(face: CubeFace, allowEarlyRefresh: boolean = true) {
        const verticesGlobal = this.getVertexCoordinatesFromFace(face);
        const verticesScreen = verticesGlobal.map(this.getScreenCoordinatesFromWorldPosition, this);
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
        let visible = 
            (face == CubeFace.Front  && this.camera.position.x >  0.5) ||
            (face == CubeFace.Back   && this.camera.position.x < -0.5) ||
            (face == CubeFace.Top    && this.camera.position.y >  0.5) ||
            (face == CubeFace.Bottom && this.camera.position.y < -0.5) ||
            (face == CubeFace.Left   && this.camera.position.z >  0.5) ||
            (face == CubeFace.Right  && this.camera.position.z < -0.5);
        // const verticesGlobal = this.getVertexCoordinatesFromFace(face);
        // const middle = verticesGlobal[0].add(verticesGlobal[1]).add(verticesGlobal[2]).add(verticesGlobal[3]).divideScalar(4);
        // // if (renderDebugCubes) {
        // //     debugCubes[4].position.copy(middle);
        // // }
        // const p = middle.clone().project(this.camera);
        // const intersects = this.raycastNdc(new Vector2(p.x, p.y));
        // let visible = false;
        // if (intersects.length > 0 && intersects[0].point) {
        //     visible = intersects[0].point.distanceTo(middle) < 0.1;
        // }
        if (this.faceVisibility[face] != visible) {
            this.context.log(`[${CubeFace[face]}] Visible: ${visible} (previously: ${this.faceVisibility[face]})`)
            this.faceVisibility[face] = visible;
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

    private debouncedVisibilityAndLodUpdateTimeoutHandler: number = 0;

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

    printTemplateDownloading: boolean = false;
    private printTemplateCurrentFace: number = 0;
    private printTemplateResults: string[] = [];
    
    startDownloadPrintTemplate() {
        if (this.printTemplateDownloading) {
            return;
        }
        this.setCubeLightingEnabled(false);
        this.context.interaction.showPrintTemplateLoader()
        this.context.log("Start downloading print template");
        this.renderer.setSize(1500, 1500);
        const aspect = 1;
        if (this.context.isometricMode) {
            (this.camera as OrthographicCamera).left = this.isometricFrustumSize * aspect / -2;
            (this.camera as OrthographicCamera).right = this.isometricFrustumSize * aspect / 2;
            (this.camera as OrthographicCamera).top = this.isometricFrustumSize / 2;
            (this.camera as OrthographicCamera).bottom = this.isometricFrustumSize / -2;
            this.camera.updateProjectionMatrix();
        } else {
           (this.camera as any).aspect = aspect;
            this.camera.updateProjectionMatrix();
        }
        this.renderer.setPixelRatio(1);

        this.printTemplateCurrentFace = -1;
        this.printTemplateDownloading = true;
        this.printTemplateResults = [];
        this.downloadScreenshotAsDataUrl(); // fixes issue on some devices that the first screenshot download fails
        this.processNextFaceForPrintTemplate();
    }

    processNextFaceForPrintTemplate() {
        if (this.printTemplateCurrentFace !== -1) {
            this.printTemplateResults.push(this.downloadScreenshotAsDataUrl()); 
            this.context.log("Finished face", CubeFace[this.printTemplateCurrentFace], this.printTemplateResults[this.printTemplateResults.length - 1].length);
        }
        this.printTemplateCurrentFace += 1;
        if (this.printTemplateCurrentFace >= 6) {
            this.finishDownloadPrintTemplate();
            return;
        }
        this.context.interaction.applyCameraPreset(`Single Face (${CubeFace[this.printTemplateCurrentFace]})`);
        this.updateVisibilityAndLods();
        this.requestRender();
    }

    async finishDownloadPrintTemplate() {
        this.printTemplateDownloading = false;
        this.context.interaction.applyCameraPreset();
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
    }


    async downloadScreenshotFromUi(includeUi: boolean, filename: string = "", dpiscale: number = 1) {
        if (dpiscale != 1) {
            this.renderer.setPixelRatio(window.devicePixelRatio * dpiscale);
            this.render();
        }
        let dataUrl = "";
        const uiClasses = ["bottom-left-ui", "axis-label-parent"];
        const filterClasses = (node: HTMLElement) => {
            let exclusionClasses = ["toolbar-ui", "status-message", "dataset-info-wrapper", "options-ui", "hover-info-ui", "print-template-result-wrapper", "print-template-wrapper"];
            if (!includeUi) {
                exclusionClasses = exclusionClasses.concat(uiClasses);
            }
            return !exclusionClasses.some((classname) => node.classList?.contains(classname));
        }
        try {
            dataUrl = await toPng(this.parent, { "filter": filterClasses, "pixelRatio": window.devicePixelRatio * dpiscale, "style": { backgroundColor: "transparent" } });
        } catch (e) {
            console.error("Error during screenshot generation", e);
            return;
        }
        let a = document.createElement('a');
        a.href = dataUrl;
        const cubeName = this.context.interaction.selectedCube.id !== "default" ? `${this.context.interaction.selectedCube.id}-` : "";
        const parameterName = this.context.interaction.selectedParameterId !== "default_var" ? `${this.context.interaction.selectedParameterId}-` : "";
        a.download = filename || `lexcube-${cubeName}${parameterName}${new Date().toLocaleDateString()}-${new Date().toLocaleTimeString()}.png`;
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
    
    overflow: boolean[] = [false, false, false];

    updateOverflowSettings(overflowX: boolean, overflowY: boolean, overflowZ: boolean, allowWidgetUpdate: boolean = true) {
        this.overflow = [overflowX, overflowY, overflowZ];
        for (let face = 0; face < 6; face++) {
            this.cube.material[face].uniforms["overflowX"].value = face < 4 ? overflowX : overflowY;
            this.cube.material[face].uniforms["overflowY"].value = face < 2 ? overflowY : overflowZ;
        }
        if (this.context.widgetMode && allowWidgetUpdate) {
            this.updateWidgetDimensionWrapSettings(overflowX, overflowY, overflowZ)
        }
    }
}


export { CubeRendering }