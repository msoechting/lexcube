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

import { clamp } from 'three/src/math/MathUtils';
import defaultColormaps from '../../content/default-colormaps.json';
import { TileData } from '../tiledata';
import { Parameter } from '../core/parameters';


interface ColormapUIHostState {
    get widgetMode(): boolean;
    get expertMode(): boolean;
    get isClientPortrait(): boolean;
    get tileData(): TileData;
    get selectedParameter(): Parameter;
    get floatDisplaySignificance(): number;
    log(...args: any[]): void;
    toFixed(float: number): string;
    onWidgetColormapChanged(name: string): void;
    onWidgetColormapRangeChanged(min: number | null, max: number | null): void;
}


class ColormapUIManager {
    private host: ColormapUIHostState;

    private colormapScaleCanvasContext!: CanvasRenderingContext2D;
    private colormapScaleWidth: number;
    private colormapScaleHeight: number = 25;

    selectedColormapName!: string;
    selectedColormapCategory!: string;

    // HTML element references
    private htmlColormapFlippedCheckbox!: HTMLInputElement;
    private htmlColormapPercentileCheckbox!: HTMLInputElement;
    private htmlColormapButtonList!: HTMLDivElement;
    private htmlColormapMinInputDiv!: HTMLInputElement;
    private htmlColormapMaxInputDiv!: HTMLInputElement;
    private htmlColormapScale!: HTMLElement;
    private htmlColormapScaleGradient!: HTMLElement;
    private htmlColormapScaleTexts!: HTMLCollectionOf<Element>;
    private htmlColormapScaleUnitText!: HTMLElement;
    htmlColormapOptions!: HTMLElement;
    private htmlColormapRangeForm!: HTMLFormElement;

    constructor(host: ColormapUIHostState) {
        this.host = host;
        this.colormapScaleWidth = host.widgetMode ? 180 : (host.isClientPortrait ? 180 : 230);
    }

    setupHtmlReferences(htmlParent: HTMLElement) {
        const getByClass = (className: string) => {
            const elements = htmlParent.getElementsByClassName(className);
            if (elements.length != 1) {
                console.warn("Tried to access HTML element of class name", className, "but got", elements.length, "results.")
            }
            return elements[0] as HTMLElement;
        };

        this.htmlColormapFlippedCheckbox = getByClass("colormap-flipped-checkbox") as HTMLInputElement;
        this.htmlColormapPercentileCheckbox = getByClass("colormap-percentile-checkbox") as HTMLInputElement;
        this.htmlColormapButtonList = getByClass("colormap-list") as HTMLDivElement;
        this.htmlColormapMinInputDiv = getByClass("colormap-min-input") as HTMLInputElement;
        this.htmlColormapMaxInputDiv = getByClass("colormap-max-input") as HTMLInputElement;
        this.htmlColormapScale = getByClass("color-scale");
        this.htmlColormapScaleGradient = getByClass("color-scale-gradient");
        this.htmlColormapScaleTexts = htmlParent.getElementsByClassName("color-scale-label");
        this.htmlColormapScaleUnitText = getByClass("color-scale-unit-label");
        this.htmlColormapOptions = getByClass("colormap-options");
        this.htmlColormapRangeForm = getByClass("colormap-range-form") as HTMLFormElement;
    }

    setupEventHandlers(onColormapRangeSubmit: () => void) {
        this.htmlColormapFlippedCheckbox.onchange = () => {
            this.host.tileData.setColormapFlipped(this.htmlColormapFlippedCheckbox.checked);
            this.host.tileData.colormapHasChanged(true, false);
        };

        this.htmlColormapPercentileCheckbox.onchange = () => {
            this.host.tileData.colormapUseStandardDeviation = this.htmlColormapPercentileCheckbox.checked;
            this.host.tileData.colormapHasChanged(true, false);
        };

        this.htmlColormapRangeForm.onsubmit = (ev) => {
            ev.preventDefault();
            onColormapRangeSubmit();
        };

        this.htmlColormapScale.onclick = () => {
            this.htmlColormapOptions.style.display = this.htmlColormapOptions.style.display == "flex" ? "none" : "flex";
            if (this.htmlColormapOptions.style.display == "flex") {
                for (let categoryHeaderOrContainer of this.htmlColormapButtonList.children) {
                    if (categoryHeaderOrContainer.getAttribute("collapsed") == "false") {
                        (categoryHeaderOrContainer as any).onclick();
                    }
                    for (let f of categoryHeaderOrContainer.children) {
                        if (f.classList.contains("selected")) {
                            const header = categoryHeaderOrContainer.previousElementSibling!;
                            if (header.getAttribute("collapsed") == "true") {
                                (header as any).onclick();
                            }
                            f.scrollIntoView({ block: this.host.widgetMode ? "nearest" : "center" });
                        }
                    }
                }
            }
        };
    }

    initializeScale() {
        const canvas = document.createElement("canvas");
        canvas.width = this.colormapScaleWidth;
        canvas.height = this.colormapScaleHeight;
        this.colormapScaleCanvasContext = canvas.getContext("2d")!;
        this.htmlColormapScaleGradient.appendChild(canvas);
    }

    private updateScale(data: number[][]) {
        const gradient = this.colormapScaleCanvasContext.createLinearGradient(0, 0, this.colormapScaleWidth, 0);
        for (let i = 0; i < data.length; i++) {
            const p = i / (data.length - 1);
            const c = data[i];
            gradient.addColorStop(p, `rgb(${c[0]}, ${c[1]}, ${c[2]})`);
        }
        this.colormapScaleCanvasContext.fillStyle = gradient;
        this.colormapScaleCanvasContext.fillRect(0, 0, this.colormapScaleWidth, this.colormapScaleHeight);
    }

    updateScaleFlip(flipped: boolean) {
        this.htmlColormapFlippedCheckbox.checked = flipped;
        this.htmlColormapScaleGradient.style.scale = `${flipped ? "-1" : "1"} 1`;
    }

    updateScaleTexts(minValue: number, maxValue: number) {
        const count = this.htmlColormapScaleTexts.length;
        this.htmlColormapScaleUnitText.innerHTML = `${this.host.selectedParameter.getUnitHTML()}`;
        for (let i = 0; i < count; i++) {
            const p = i / (count - 1);
            this.htmlColormapScaleTexts[i].textContent = `${this.host.toFixed(this.host.selectedParameter.getConvertedDataValue(p * (maxValue - minValue) + minValue))}`;
        }
    }

    initializeUi() {
        const gradientResolution = 200;
        const canvas = document.createElement("canvas");
        canvas.height = 1;
        canvas.width = gradientResolution;
        const canvasContext = canvas.getContext("2d")!;

        const colormapCategories = new Map<string, string>([
            ["Sequential", "Sequential"],
            ["PerceptuallyUniformSequential", "Perceptually Uniform Sequential"],
            ["Diverging", "Diverging"],
            ["Crameri", "Scientific Colormaps (by Fabio Crameri)"],
            ["cmocean", "cmocean"],
            ["Proplot", "ProPlot"],
            ["Cyclic", "Cyclic"],
            ["Miscellaneous", "Miscellaneous"],
        ]);
        for (let category of colormapCategories.keys()) {
            const categoryName = colormapCategories.get(category)!;
            const colormapCategoryHeader = document.createElement("div");
            colormapCategoryHeader.innerText = `► ${categoryName}`;
            colormapCategoryHeader.style.cursor = "pointer";
            colormapCategoryHeader.style.fontWeight = "bold";
            this.htmlColormapButtonList.appendChild(colormapCategoryHeader);

            const colormapCategoryContainer = document.createElement("div");
            colormapCategoryContainer.classList.add("colormap-category");
            colormapCategoryContainer.style.display = 'none';
            colormapCategoryContainer.style.maxHeight = "180px";
            colormapCategoryContainer.style.overflowY = "auto";
            this.htmlColormapButtonList.appendChild(colormapCategoryContainer);

            colormapCategoryHeader.setAttribute("collapsed", "true");

            colormapCategoryHeader.onclick = () => {
                if (colormapCategoryHeader.getAttribute("collapsed") == "true") {
                    colormapCategoryHeader.textContent = `▼ ${categoryName}`;
                    colormapCategoryContainer.style.display = 'block';
                    colormapCategoryHeader.setAttribute("collapsed", "false");
                    for (let otherCategoryHeader of this.htmlColormapButtonList.children) {
                        if (otherCategoryHeader != colormapCategoryHeader) {
                            if (otherCategoryHeader.getAttribute("collapsed") == "false") {
                                (otherCategoryHeader as any).onclick();
                            }
                        }
                    }
                    colormapCategoryHeader.scrollIntoView({ block: this.host.widgetMode ? "nearest" : "center" });
                } else {
                    colormapCategoryHeader.textContent = `► ${categoryName}`;
                    colormapCategoryContainer.style.display = 'none';
                    colormapCategoryHeader.setAttribute("collapsed", "true");
                }
            };

            const colormapNames = Object.keys((defaultColormaps as any)[category]);
            for (let j = 0; j < colormapNames.length; j++) {
                const name = colormapNames[j];
                const data = this.getDataFromName(name);

                const button = document.createElement("button");
                const gradient = canvasContext.createLinearGradient(0, 0, gradientResolution, 0);

                for (let i = 0; i < data.length; i++) {
                    const p = i / (data.length - 1);
                    const c = data[i];
                    gradient.addColorStop(p, `rgb(${c[0]}, ${c[1]}, ${c[2]})`);
                }

                canvasContext.fillStyle = gradient;
                canvasContext.fillRect(0, 0, canvas.width, canvas.height);

                button.textContent = name;

                let img_b64 = canvas.toDataURL('image/png');
                button.style.backgroundImage = `url(${img_b64})`;
                button.onclick = () => { this.selectByName(name); };
                button.title = name;
                colormapCategoryContainer.appendChild(button);
            }
        }
    }

    deselectInUi() {
        const selected = "selected";
        for (let i = 0; i < this.htmlColormapButtonList.children.length; i++) {
            const category = this.htmlColormapButtonList.children[i] as HTMLElement;
            for (let element of category.children) {
                element.classList.remove(selected);
            }
        }
    }

    selectByName(name: string): boolean {
        const category = Object.keys(defaultColormaps).find(c => Object.keys((defaultColormaps as any)[c]).includes(name))!;
        if (!category) {
            console.error("Cannot find colormap", name);
            return false;
        }
        this.selectedColormapCategory = category;
        this.selectedColormapName = name;
        this.host.log("selectColormapByName", name, this.selectedColormapCategory);

        const selected = "selected";
        for (let i = 0; i < this.htmlColormapButtonList.children.length; i++) {
            const category = this.htmlColormapButtonList.children[i] as HTMLElement;
            for (let element of category.children) {
                if (name == (element as HTMLElement).title) {
                    element.classList.add(selected);
                } else {
                    element.classList.remove(selected);
                }
            }
        }
        this.updateScale(this.getDataFromName(name));
        if (this.host.widgetMode) {
            this.host.onWidgetColormapChanged(name);
        }
        this.host.tileData.selectColormapByName(name);
        return true;
    }

    selectByData(data: number[][]): boolean {
        this.selectedColormapName = "Custom Colormap";
        this.selectedColormapCategory = "Custom";
        this.updateScale(data);
        this.host.tileData.selectColormapByData(data);
        return true;
    }

    selectArbitraryLinear(parameterIndex: number) {
        const names = ["viridis", "algae", "deep", "dense", "haline", "ice", "speed", "tempo", "turbid"];
        this.selectByName(names[parameterIndex % names.length]);
    }

    clearRangeUi() {
        this.htmlColormapMinInputDiv.value = "";
        this.htmlColormapMaxInputDiv.value = "";
    }

    updateRangeFromValues() {
        this.htmlColormapMinInputDiv.value = (this.host.tileData.colormapMinValueOverride !== null) ? this.host.toFixed(this.host.tileData.colormapMinValueOverride) : "";
        this.htmlColormapMaxInputDiv.value = (this.host.tileData.colormapMaxValueOverride !== null) ? this.host.toFixed(this.host.tileData.colormapMaxValueOverride) : "";
    }

    updateRangePlaceholders() {
        const td = this.host.tileData;
        if (this.host.expertMode) {
            this.htmlColormapMinInputDiv.placeholder = (td.colormapUseStandardDeviation) ? `${this.host.toFixed(td.statisticalColormapLowerBound)} (${td.statisticalColormapLowerBound == td.observedMinValue ? "same" : this.host.toFixed(td.observedMinValue)})` : this.host.toFixed(td.observedMinValue);
            this.htmlColormapMaxInputDiv.placeholder = (td.colormapUseStandardDeviation) ? `${this.host.toFixed(td.statisticalColormapUpperBound)} (${td.statisticalColormapUpperBound == td.observedMaxValue ? "same" : this.host.toFixed(td.observedMaxValue)})` : this.host.toFixed(td.observedMaxValue);
        } else {
            this.htmlColormapMinInputDiv.placeholder = (td.colormapUseStandardDeviation && !td.ignoreStatisticalColormapBounds) ? `${this.host.toFixed(td.statisticalColormapLowerBound)}` : this.host.toFixed(td.observedMinValue);
            this.htmlColormapMaxInputDiv.placeholder = (td.colormapUseStandardDeviation && !td.ignoreStatisticalColormapBounds) ? `${this.host.toFixed(td.statisticalColormapUpperBound)}` : this.host.toFixed(td.observedMaxValue);
        }
    }

    updateOverrideRangesFromUi(updateColormap: boolean = true) {
        const td = this.host.tileData;
        if (this.htmlColormapMinInputDiv.value != "" && !isNaN(parseFloat(this.htmlColormapMinInputDiv.value))) {
            td.colormapMinValueOverride = parseFloat(this.htmlColormapMinInputDiv.value);
        } else {
            this.htmlColormapMinInputDiv.value = "";
            td.colormapMinValueOverride = null;
        }
        if (this.htmlColormapMaxInputDiv.value != "" && !isNaN(parseFloat(this.htmlColormapMaxInputDiv.value))) {
            td.colormapMaxValueOverride = parseFloat(this.htmlColormapMaxInputDiv.value);
        } else {
            this.htmlColormapMaxInputDiv.value = "";
            td.colormapMaxValueOverride = null;
        }
        if (this.host.widgetMode) {
            this.host.onWidgetColormapRangeChanged(td.colormapMinValueOverride, td.colormapMaxValueOverride);
        }
        if (updateColormap) {
            td.colormapHasChanged(true, false);
        }
    }

    convertDataToRGB8(source: number[][]): number[][] {
        const data: number[][] = JSON.parse(JSON.stringify(source));

        const count = data.length;
        for (let i = 0; i < count - 1; i++) {
            const p0 = source[i];
            const p1 = source[i + 1];
            const p = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
            data.splice(i * 2 + 1, 0, p);
        }

        for (let i = 0; i < data.length; i++) {
            data[i][0] = clamp(Math.round(data[i][0] * 255), 0, 255);
            data[i][1] = clamp(Math.round(data[i][1] * 255), 0, 255);
            data[i][2] = clamp(Math.round(data[i][2] * 255), 0, 255);
        }
        return data;
    }

    getDataFromName(name: string): number[][] {
        const category = Object.keys(defaultColormaps).find(c => Object.keys((defaultColormaps as any)[c]).includes(name))!;
        const source = (defaultColormaps as any)[category][name] as number[][];
        return this.convertDataToRGB8(source);
    }

    setMinInputValue(value: string) {
        this.htmlColormapMinInputDiv.value = value;
    }

    setMaxInputValue(value: string) {
        this.htmlColormapMaxInputDiv.value = value;
    }

    setFlippedChecked(checked: boolean) {
        this.htmlColormapFlippedCheckbox.checked = checked;
    }
}

export { ColormapUIManager, ColormapUIHostState }
