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

import { DeviceOrientation } from './constants';
import { CubeInteraction } from './interaction';
import { Networking } from './networking';
import { CubeRendering } from './rendering';
import { TileData } from './tiledata';

const apiServerUrl = document.URL.indexOf("localhost") > -1 ? "http://localhost:5000" : ""


class CubeClientContext {
    rendering: CubeRendering;
    networking: Networking;
    tileData: TileData;
    interaction: CubeInteraction;

    debugMode: boolean = false;
    studioMode: boolean = false;
    isometricMode: boolean = false;
    expertMode: boolean = false;
    scriptedMode: boolean = false;
    orchestrationMinionMode: boolean = false;
    orchestrationMasterMode: boolean = false;
    noUiMode: boolean = false;
    scriptedMultiViewMode: boolean = false;
    textureFilteringEnabled: boolean = false;

    screenOrientation: DeviceOrientation = (screen.orientation ? (screen.orientation.type.indexOf("landscape") > -1 ? DeviceOrientation.Landscape : DeviceOrientation.Portrait) : (window.innerHeight > window.innerWidth ? DeviceOrientation.Portrait : DeviceOrientation.Landscape));
    screenAspectRatio: number = window.screen.width / window.screen.height;

    widgetMode: boolean = false;


    touchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    widgetPostStartup: () => void = () => {};

    constructor(widgetMode: boolean = false, htmlParent: HTMLElement = document.body, isometricMode: boolean = false) {
        this.widgetMode = widgetMode;
        this.isometricMode = isometricMode; 

        if (!widgetMode) {
            this.isometricMode = this.isometricMode || document.URL.indexOf("isometric") > 0;
            this.debugMode = document.URL.indexOf("debug") > 0;
            this.studioMode = document.URL.indexOf("studio") > 0;
            this.expertMode = document.URL.indexOf("expert") > 0;
            this.scriptedMode = document.URL.indexOf("scripted") > 0;
            this.orchestrationMinionMode = document.URL.indexOf("orchestrationMinion") > 0;
            this.orchestrationMasterMode = document.URL.indexOf("orchestrationMaster") > 0;
            this.noUiMode = document.URL.indexOf("noUi") > 0;
            this.scriptedMultiViewMode = document.URL.indexOf("scriptedMultiView") > 0;
            this.textureFilteringEnabled = document.URL.indexOf("textureFiltering") > 0;
        }

        this.rendering = new CubeRendering(this, htmlParent);
        this.networking = new Networking(this, apiServerUrl);
        this.tileData = new TileData(this);
        this.interaction = new CubeInteraction(this, htmlParent);

        if (this.scriptedMode) {
            (window as any).downloadScreenshotFromConsole = this.rendering.downloadScreenshotAsDataUrl.bind(this.rendering);
            (window as any).allTileDownloadsFinished = this.interaction.getRenderedAfterAllTilesDownloaded.bind(this.interaction);
            (window as any).getAvailableCubes = this.interaction.getAvailableCubes.bind(this.interaction);
            (window as any).getAvailableParameters = this.interaction.getAvailableParameters.bind(this.interaction);
            (window as any).selectCube = this.interaction.selectCubeById.bind(this.interaction);
            (window as any).selectParameter = this.interaction.selectParameter.bind(this.interaction);
        }

        if (!this.widgetMode) {
            const featureCheck = this.checkForFeatures();
            if (featureCheck.success) {
                this.startup();
            } else {
                window.alert(featureCheck.message);
                document.getElementById("tutorial-wrapper")!.style.display = "none";
                document.getElementById("status-message")!.innerHTML = "LexCube failed to start.<br>Please retry on a more modern browser/device."
            }
        }        
    }

    isClientPortrait() {
        return this.screenOrientation == DeviceOrientation.Portrait;
    }


    checkWebAssembly() {
        try {
            if (typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function") {
                const module = new WebAssembly.Module(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
                if (module instanceof WebAssembly.Module) {
                    return new WebAssembly.Instance(module) instanceof WebAssembly.Instance;
                }
            }
        } catch (e) {
        }
        return false;
    }

    checkForFeatures() {
        let success = true;
        let message = "";
        if (!document.createElement('canvas').getContext('webgl2')) {
            if (navigator.userAgent.indexOf("AppleWebKit") > -1) {
                if (navigator.userAgent.indexOf("iPhone") > -1) {
                    message = "WebGL2 needs to be enabled to run LexCube. You can enable it in iOS 12+ at: 'Settings' > 'General' > 'Safari' > 'Advanced' > 'Experimental Features' > 'WebGL 2.0'";
                } else {
                    message = "WebGL2 needs to be enabled to run LexCube. You can enable it at: 'Develop' > 'Experimental Features' > 'WebGL 2.0'. If you don't see the Develop menu, choose 'Safari' > 'Preferences' > 'Advanced' > 'Show Develop menu in menu bar'.";
                }
            } else if (typeof WebGL2RenderingContext !== 'undefined') {
                message = "Your browser supports WebGL2 but it might be disabled. Please enable it or use a more modern browser/device to access LexCube.";
            } else {
                message = "Your browser does not support WebGL2, which is a requirement for LexCube. Please use a more modern browser/device to access LexCube.";
            }
            success = false;
        }
        if (!window.WebSocket) {
            message = "Your browser does not support Websockets, which is a requirement for LexCube. Please use a more modern browser/device to access LexCube.";
            success = false;
        }
        if (!this.checkWebAssembly()) {
            message = "Your browser does not support WebAssembly, which is a requirement for LexCube. Please use a more modern browser/device to access LexCube.";
            success = false;
        }
        return { success: success, message: message };
    }

    async startup() {
        this.networking.connect();
        await this.interaction.startup();
        this.rendering.startup();
        this.networking.postStartup();
        this.widgetPostStartup();
    }
    
    log(...params: any[]) {
        if (this.debugMode || this.expertMode) {
            console.log(...params);
        }
    }
}

if ((window as any).lexcubeStandalone) {
    new CubeClientContext();
}
export { CubeClientContext }
