
class FastLineSegmentMap {
    private minValue: number;
    private maxValue: number;
    private binCount: number;
    private binSize: number;
    private tree: number[][];

    constructor(component: number, bins: number, positions: number[], indices: number[]) {
        // component == 1: Y, component == 2: Z
        this.binCount = bins;
        this.minValue = positions.reduce((prev, curr, i) => i % 3 == component ? Math.min(prev, curr) : prev, Infinity);
        this.maxValue = positions.reduce((prev, curr, i) => i % 3 == component ? Math.max(prev, curr) : prev, -Infinity) + 0.0001;

        this.binSize = (this.maxValue - this.minValue) / this.binCount;
        this.tree = new Array(this.binCount).fill(0).map(() => []);

        this.construct(component, indices, positions);
    }

    static fromObject(obj: any): FastLineSegmentMap {
        const instance = Object.create(FastLineSegmentMap.prototype);
        return Object.assign(instance, obj);
    }

    private construct(component: number, indices: number[], positions: number[]) {
        for (let p = 0; p < indices.length; p += 2) {
            const p1Index = indices[p] * 3;
            const p2Index = indices[p + 1] * 3;
            const p1BinIndex = Math.floor((positions[p1Index + component] - this.minValue) / this.binSize);
            const p2BinIndex = Math.floor((positions[p2Index + component] - this.minValue) / this.binSize);
            const lowerBinIndex = Math.min(p1BinIndex, p2BinIndex);
            const upperBinIndex = Math.max(p1BinIndex, p2BinIndex);
 
            for (let binIndex = lowerBinIndex; binIndex <= upperBinIndex; binIndex++) {
                this.tree[binIndex].push(p1Index / 3, p2Index / 3);
            }
        }
    }

    getAllIndicesAtValue(value: number) {
        const binIndex = Math.floor((value - this.minValue) / this.binSize);
        return this.tree[binIndex] || [];
    }
}

export default FastLineSegmentMap;
