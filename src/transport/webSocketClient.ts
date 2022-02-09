import { createPreferencesFromBackend, loadPreferencesFromStorage, savePreferencesToStorage } from "@/preferences";
import { IPreferences, rawPreferences } from "@/preferences/types";
import { PlaceholderService } from "@/services/placeholder-service";
import { StickerService } from "@/services/sticker-service";
import Sockette from "sockette";
import { RuntimePortManager } from "./runtimePort";

export class WebSocketClient {

    static create = async (host?: string): Promise<WebSocketClient> => {
        console.trace('creating new socket client!');
        if (!host) {
            const configHost = await chrome.storage.local.get('backendHost');
            // console.log(`pulled host config: ${JSON.stringify(configHost)}`);
            if (configHost['backendHost']) {
                host = configHost['backendHost'];
            }
        }
        return new WebSocketClient(host);
    }
    private _ports: { [tabId: number]: chrome.runtime.Port | undefined; } = {};
    private _portManager?: RuntimePortManager;
    /**
     *
     */
    private constructor(host?: string) {
        this.webSocket = this.connectTo(host);
    }

    private messageQueue: any[] = [];

    private webSocket?: Sockette;

    defaultHost = "ws://localhost:8090/ws"

    sendObj = (message: object, callback?: () => any|void) => {
        this.send(JSON.stringify(message), callback);
    }

    usePorts = (ports: {[tabId: number]: chrome.runtime.Port|undefined}) => {
        this._ports = ports;
    }

    usePortManager = (mgr: RuntimePortManager): WebSocketClient => {
        this._portManager = mgr;
        return this;
    }

    send = (message: string, callback?: any) => {
        //sockette means the socket is never not ready
        // that doesn't mean it can't error out though

        try {
            this.webSocket?.send(message)
            if (typeof callback !== 'undefined') {
                callback();
            }
        } catch {
            this.messageQueue.push(message);
        }
    };



    private sendRuntimeMessage = (requestId: string, tabId: string, obj: object) => {
        if (requestId && this._portManager) {
            this._portManager.sendMessage(obj, requestId, tabId.toString());
        }
        if (tabId) {
            const port = this._ports[tabId];
            if (port) {
                port.postMessage(obj);
            } else {
                chrome.tabs.sendMessage(parseInt(tabId), obj);
            }
        } else {
            chrome.runtime.sendMessage(obj)
            // throw new Error("Cannot deliver message without tab ID!");
        }
    }
    
    
    public get ready() : boolean {
        // return this.webSocket?.readyState === 1;
        return true;
    }
    

    private connectTo = (host?: string): Sockette | undefined => {
        host ??= this.defaultHost;
        try {
            const onOpen = () => {
                while (this.messageQueue.length > 0) {
                    webSocket.send(this.messageQueue.pop());
                }
             };
             const onMessage = (event) => {
                const response = JSON.parse(event.data);
                this.processServerMessage(response);
            };
            const onClose = (e) => {
                if (e.code !== 4999) {
                    chrome.runtime.sendMessage({msg: 'socketClosed'});
                    console.error('Socket is closed.', e);
                    // setTimeout(() => {
                    //     this.connectTo(host);
                    // }, 5000);
                }
            };
            const onError = function (err) {
                console.error('Socket encountered error: ', err.message, 'Closing socket');
                // webSocket.close();
            };
            const webSocket = new Sockette(host, {
                timeout: 60,
                maxAttempts: 10,
                onopen: onOpen,
                onmessage: onMessage,
                onreconnect: (e) => {
                    chrome.runtime.sendMessage({msg: 'socketReconnect'});
                    while (this.messageQueue.length > 0) {
                        webSocket.send(this.messageQueue.pop());
                    }
                },
                onmaximum: (e) => console.error('Socket reconnection failed!', e),
                onclose: onClose,
                onerror: onError
            });
            // webSocket.onopen = onOpen
            // webSocket.onmessage = onMessage
            // webSocket.onclose = onClose;
            // webSocket.onerror = onError;
            return webSocket;
        } catch (e: any) {
            console.warn("Failed to connect to WebSocket! Cannot connect to the target endpoint.",  e.toString(), e);
        }
    }

    public get messageHandlers() : {[key: string]: (response: any) => void} {
        return {
            'censorImage': (response) => this.processCensoredImageResponse(response),
            'detectPlaceholdersAndStickers': this.processPlaceholderAndStickerResponse,
            'getUserPreferences': this.processUserPreferences
        }
    }
    

    processServerMessage = (response: any) => {
        console.debug(`server response received`, response);
        const handler = this.messageHandlers[response['requestType']];
        if (handler !== undefined) {
            console.log('running handler for server message', response.requestType, response);
            handler(response);
        } else {
            console.warn('received unmatched server message!', response);
        }
    }

    processCensoredImageResponse = async (response) => {
        const prefs = await loadPreferencesFromStorage();
        let url: string;
        // console.log(`parsing image response`, response);
        if (parseInt(response.status) === 200 || parseInt(response.status) === 304) {
            url = response.url;
        } else {
            url = prefs.errorMode === 'subtle'
                ? chrome.runtime.getURL("images/error_simple.png")
                : chrome.runtime.getURL("images/error_normal.jpg");
            // we don't have an NSFW error screen yet
            // ignore that, we do now
        }
        const body = {
            msg: "setSrc", censorURL: url,
            id: response.id, tabid: response.tabid, type: response.type
        };
        this.sendRuntimeMessage(response.ide, response.tabid, body)
        
    }

    processPlaceholderAndStickerResponse = (response) => {
        if (parseInt(response.status) === 200) {
            console.log(`sticker response:`, response)
            //TODO: we don't actually need to do this anymore, we don't use the backend placeholders anywhere
            PlaceholderService.loadBackendPlaceholders(response)
            StickerService.loadAvailableStickers(response);
        }
    }

    processUserPreferences = async (response): Promise<IPreferences> => {
        const log = (...data: any[]) => {
            // console.debug(...data);
            //this is just here to make debugging things easier
        }
        const preferences = await loadPreferencesFromStorage();
        if (parseInt(response.status) === 200) {
            const rawPrefs = response["preferences"] as rawPreferences;
            log('raw prefs', rawPrefs);
            const backendPrefs = createPreferencesFromBackend(rawPrefs);
            log('backend prefs', backendPrefs);
            log('loaded prefs', preferences);
            const mergedPrefs = {
                ...backendPrefs,
                ...preferences
            };
            log('merged prefs', mergedPrefs);
            await savePreferencesToStorage(mergedPrefs, true);
            const newPrefs = await loadPreferencesFromStorage();
            log('new prefs as stored:', newPrefs);
            return mergedPrefs;
        }
        return preferences;
    }

    close = () => {
        this.webSocket?.close(4999);
    }
}