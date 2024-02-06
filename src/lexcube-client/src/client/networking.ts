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

import { io, Socket } from 'socket.io-client';
import { Vector2 } from 'three';
import { CubeClientContext } from './client';
import { Tile } from './tiledata';
import { PACKAGE_VERSION } from './constants';

class Networking {
    private receivedBytes = 0;
    private apiServerUrl: string;
    private useMetaDataCache: boolean = false;
    private context: CubeClientContext;
    private tileWebsocket!: Socket;
    private orchestratorChannel!: BroadcastChannel;
    private connectionLostAlerted: boolean = false;

    private tileCache: Map<string, any>;

    constructor(context: CubeClientContext, apiServerUrl: string) {
        this.context = context;
        this.apiServerUrl = apiServerUrl;
        this.tileCache = new Map<string, any>();
    }

    connect() {
        if (this.context.widgetMode) {
            return;
        }
        this.connectTileWebsockets();
        if (this.context.orchestrationMinionMode || this.context.orchestrationMasterMode) {
            this.connectOrchestratorChannel();
        }
    }

    postStartup() {
        if (this.context.widgetMode) {
            this.widgetVersionCheck();
            return;
        }
    }

    connectTileWebsockets() {
        this.tileWebsocket = io(this.apiServerUrl, {path:"/ws/socket.io/", transports:["websocket"], reconnection: true, reconnectionDelay: 5000})
        this.tileWebsocket.on('connect', this.onConnectTileWebsockets.bind(this));
        this.tileWebsocket.on('disconnect', this.onDisconnectTileWebsockets.bind(this));
        this.tileWebsocket.on('tile_data', this.onTileWebsocketMessage.bind(this));
        this.tileWebsocket.on('connect_error', (e: any) => { 
            console.error("Connect error (tile websockets)", e); 
            if (!this.connectionLostAlerted) {
                this.connectionLostAlerted = true;
                window.alert("It seems the internet connection was lost. Please reconnect to the internet.")}
            }
        );
        return new Promise<void>(resolve => { this.tileWebsocket.on('connect', () => resolve() )})
    }
    
    connectOrchestratorChannel() {
        this.orchestratorChannel = new BroadcastChannel("orchestrating");
        this.orchestratorChannel.addEventListener('message', this.onOrchestratorChannelMessage.bind(this));
        this.orchestratorChannel.addEventListener('message_error', (e: Event) => { 
            console.error("Message parse error (orchestrator broadcast)", e);
        });
    }

    private onConnectTileWebsockets() {
        this.context.log("Connected to tile websockets")
        this.connectionLostAlerted = false;
        // this.context.tileData.resetTileStatistics();
    }

    private onDisconnectTileWebsockets() {
        this.context.log("Disconnected from tile websockets")
        this.context.tileData.resetTileStatistics();
    }

    pushOrchestratorSelectionUpdate(displayOffsets: Vector2[], displaySizes: Vector2[], finalChange: boolean) {
        const mapVector2ToObject = (a: Vector2) => { return { x: a.x, y: a.y }; };
        this.orchestratorChannel.postMessage({
            type: "selection_changed",
            displayOffsets: displayOffsets.map(mapVector2ToObject),
            displaySizes: displaySizes.map(mapVector2ToObject),
            finalChange
        })
    }
    
    pushOrchestratorParameterUpdate(parameter: string) {
        this.orchestratorChannel.postMessage({
            type: "parameter_changed",
            parameter
        });
    }

    pushOrchestratorCubeUpdate(cube: string) {
        this.orchestratorChannel.postMessage({
            type: "cube_changed",
            cube
        });
    }

    private onOrchestratorChannelMessage(message: any) {
        // console.log("Received orchestrator message of type", message.data.type)
        if (message.data.type == "selection_changed") {
            const mapObjectToVector2 = (a: {x: number, y: number}) => new Vector2(a.x, a.y);
            this.context.interaction.cubeSelection.applyVectorsFromOrchestrator(message.data.displayOffsets.map(mapObjectToVector2), message.data.displaySizes.map(mapObjectToVector2), message.data.finalChange);
        } else if (message.data.type == "parameter_changed") {
            this.context.interaction.selectParameter(message.data.parameter);
        } else if (message.data.type == "cube_changed") {
            this.context.interaction.selectCubeById(message.data.cube);
        }
    }

    private onTileWebsocketMessage(message: any) {
        this.onTileData(message, message.data as ArrayBuffer)
    }

    onTileData(header: any, buffer: ArrayBuffer) {
        const tiles = Tile.fromResponseData(header.metadata);
        const sizes = header.dataSizes;
        let read = 0;
        this.receivedBytes += buffer.byteLength;
        for (let index = 0; index < tiles.length; index++) {
            const t = tiles[index];
            const size = sizes[index];
            const data = buffer.slice(read, read + size);
            this.tileCache.set(t.getHashKey(), data);
            this.context.tileData.receiveTile(t, data);
            read += size;
        }
    }

    async downloadTile(tile: Tile) {
        this.context.log(`Download tile ${tile}`)
        this.context.tileData.addTileDownloadsTriggered(1);
        this.tileWebsocket.emit('request_tile_data', tile.getRequestData());
    }
    
    async downloadTiles(requestedTiles: Tile[]) {
        this.context.tileData.addTileDownloadsTriggered(requestedTiles.length);
        const tilesToDownload: Tile[] = [];
        for (let t of requestedTiles) {
            const key = t.getHashKey();
            if (this.tileCache.has(key)) {
                this.context.tileData.receiveTile(t, this.tileCache.get(key));
                continue;
            } 
            tilesToDownload.push(t);
        }
        
        this.context.log(`Download multiple tiles (Downloading: ${tilesToDownload.length} - Cached: ${requestedTiles.length - tilesToDownload.length})`)
        if (tilesToDownload.length > 0) {
            const tileGroups = new Map<string, Tile[]>();
            tilesToDownload.forEach((t) => {
                const key = `${t.cubeId}-${t.parameter}-${t.indexDimension()}-${t.indexValue}`;
                if (tileGroups.get(key)) {
                    tileGroups.get(key)?.push(t);
                } else {
                    tileGroups.set(key, [t]);
                }
            });

            let totalData: {}[] = [];
            for (let group of tileGroups.values()) {
                let xys: number[][] = [];
                group.forEach((t) => xys.push([t.x, t.y]));
                xys.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]))
                totalData.push(group[0].getRequestDataWithMultipleXYs(xys))
            }
            this.requestTileData(totalData);
        }
    }

    requestTileDataFromWidget?: (data: any) => void;

    private requestTileData(data: any) {
        if (this.context.widgetMode) {
            this.requestTileDataFromWidget!({"request_type": "request_tile_data_multiple", "request_data": data});
        } else {
        }
    }

    async widgetVersionCheck() {
        try {
            const f = await fetch("https://version.lexcube.org");
            const j = await f.json();
            const new_version = j["current_lexcube_jupyter_version"];
            if (new_version != PACKAGE_VERSION) {
                this.context.interaction.showVersionOutofDateWarning(new_version, PACKAGE_VERSION);
            }    
        } catch (error) {
            console.log("Could not fetch version information from version.lexcube.org");
        }
    }

    fetchMetadataFromWidget?: (url_path: string) => any;

    async fetch(url_path: string) {
        if (this.context.widgetMode) {
            const d = await this.fetchMetadataFromWidget!(url_path);
            return d;
        } else {
            return await this.fetchJson(url_path);
        }
    }
    
    private async fetchJson(url_path: string) {
        let full_url = `${this.apiServerUrl}${url_path}`
        let key = `cached_api_response-${url_path}`;
        let stored = localStorage.getItem(key);
        if (this.useMetaDataCache && stored) {
            this.context.log("USING CACHED API METADATA:", full_url);
            return JSON.parse(stored);
        }
        const response = await fetch(full_url);
        const json = await response.json() as any;
        if (this.useMetaDataCache) {
            localStorage.setItem(key, JSON.stringify(json));
        }
        return json;
    }

    
}


export { Networking }