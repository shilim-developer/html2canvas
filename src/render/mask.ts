import {Bounds} from '../css/layout/bounds';
import {MASK_ORIGIN} from '../css/property-descriptors/mask-origin';
import {MASK_CLIP} from '../css/property-descriptors/mask-clip';
import {ElementContainer} from '../dom/element-container';
import {MASK_SIZE, MaskSizeInfo} from '../css/property-descriptors/mask-size';
import {Vector} from './vector';
import {MASK_REPEAT} from '../css/property-descriptors/mask-repeat';
import {getAbsoluteValue, getAbsoluteValueForTuple, isLengthPercentage} from '../css/types/length-percentage';
import {CSSValue, isIdentToken} from '../css/syntax/parser';
import {contentBox, paddingBox} from './box-sizing';
import {Path} from './path';
import {isBezierCurve} from './bezier-curve';

export const calculateMaskPositioningArea = (maskOrigin: MASK_ORIGIN, element: ElementContainer): Bounds => {
    if (maskOrigin === MASK_ORIGIN.BORDER_BOX) {
        return element.bounds;
    }

    if (maskOrigin === MASK_ORIGIN.CONTENT_BOX) {
        return contentBox(element);
    }

    return paddingBox(element);
};

export const calculateMaskPaintingArea = (maskClip: MASK_CLIP, element: ElementContainer): Bounds => {
    if (maskClip === MASK_CLIP.BORDER_BOX) {
        return element.bounds;
    }

    if (maskClip === MASK_CLIP.CONTENT_BOX) {
        return contentBox(element);
    }

    return paddingBox(element);
};

export const calculateMaskRendering = (
    container: ElementContainer,
    index: number,
    intrinsicSize: [number | null, number | null, number | null]
): [Path[], number, number, number, number] => {
    const maskPositioningArea = calculateMaskPositioningArea(
        getMaskValueForIndex(container.styles.maskOrigin, index),
        container
    );

    const maskPaintingArea = calculateMaskPaintingArea(
        getMaskValueForIndex(container.styles.maskClip, index),
        container
    );

    const maskImageSize = calculateMaskSize(
        getMaskValueForIndex(container.styles.maskSize, index),
        intrinsicSize,
        maskPositioningArea
    );

    const [sizeWidth, sizeHeight] = maskImageSize;

    const position = getAbsoluteValueForTuple(
        getMaskValueForIndex(container.styles.maskPosition, index),
        maskPositioningArea.width - sizeWidth,
        maskPositioningArea.height - sizeHeight
    );

    const path = calculateMaskRepeatPath(
        getMaskValueForIndex(container.styles.maskRepeat, index),
        position,
        maskImageSize,
        maskPositioningArea,
        maskPaintingArea
    );

    const offsetX = Math.round(position[0]);
    const offsetY = Math.round(position[1]);

    path.forEach((point) => {
        if (isBezierCurve(point)) {
            point.startControl.x = point.startControl.x - maskPositioningArea.left;
            point.startControl.y = point.startControl.y - maskPositioningArea.top;
            point.endControl.x = point.endControl.x - maskPositioningArea.left;
            point.endControl.y = point.endControl.y - maskPositioningArea.top;
            point.end.x = point.end.x - maskPositioningArea.left;
            point.end.y = point.end.y - maskPositioningArea.top;
        } else {
            point.x = point.x - maskPositioningArea.left;
            point.y = point.y - maskPositioningArea.top;
        }
    });
    return [path, offsetX, offsetY, sizeWidth, sizeHeight];
};

export const isAuto = (token: CSSValue): boolean => isIdentToken(token) && token.value === MASK_SIZE.AUTO;

const hasIntrinsicValue = (value: number | null): value is number => typeof value === 'number';

export const calculateMaskSize = (
    size: MaskSizeInfo[],
    [intrinsicWidth, intrinsicHeight, intrinsicProportion]: [number | null, number | null, number | null],
    bounds: Bounds
): [number, number] => {
    const [first, second] = size;

    if (!first) {
        return [0, 0];
    }

    if (isLengthPercentage(first) && second && isLengthPercentage(second)) {
        return [getAbsoluteValue(first, bounds.width), getAbsoluteValue(second, bounds.height)];
    }

    const hasIntrinsicProportion = hasIntrinsicValue(intrinsicProportion);

    if (isIdentToken(first) && (first.value === MASK_SIZE.CONTAIN || first.value === MASK_SIZE.COVER)) {
        if (hasIntrinsicValue(intrinsicProportion)) {
            const targetRatio = bounds.width / bounds.height;

            return targetRatio < intrinsicProportion !== (first.value === MASK_SIZE.COVER)
                ? [bounds.width, bounds.width / intrinsicProportion]
                : [bounds.height * intrinsicProportion, bounds.height];
        }

        return [bounds.width, bounds.height];
    }

    const hasIntrinsicWidth = hasIntrinsicValue(intrinsicWidth);
    const hasIntrinsicHeight = hasIntrinsicValue(intrinsicHeight);
    const hasIntrinsicDimensions = hasIntrinsicWidth || hasIntrinsicHeight;

    // If the mask-size is auto or auto auto:
    if (isAuto(first) && (!second || isAuto(second))) {
        // If the image has both horizontal and vertical intrinsic dimensions, it's rendered at that size.
        if (hasIntrinsicWidth && hasIntrinsicHeight) {
            return [intrinsicWidth as number, intrinsicHeight as number];
        }

        // If the image has no intrinsic dimensions and has no intrinsic proportions,
        // it's rendered at the size of the mask positioning area.

        if (!hasIntrinsicProportion && !hasIntrinsicDimensions) {
            return [bounds.width, bounds.height];
        }

        // TODO If the image has no intrinsic dimensions but has intrinsic proportions, it's rendered as if contain had been specified instead.

        // If the image has only one intrinsic dimension and has intrinsic proportions, it's rendered at the size corresponding to that one dimension.
        // The other dimension is computed using the specified dimension and the intrinsic proportions.
        if (hasIntrinsicDimensions && hasIntrinsicProportion) {
            const width = hasIntrinsicWidth
                ? (intrinsicWidth as number)
                : (intrinsicHeight as number) * (intrinsicProportion as number);
            const height = hasIntrinsicHeight
                ? (intrinsicHeight as number)
                : (intrinsicWidth as number) / (intrinsicProportion as number);
            return [width, height];
        }

        // If the image has only one intrinsic dimension but has no intrinsic proportions,
        // it's rendered using the specified dimension and the other dimension of the mask positioning area.
        const width = hasIntrinsicWidth ? (intrinsicWidth as number) : bounds.width;
        const height = hasIntrinsicHeight ? (intrinsicHeight as number) : bounds.height;
        return [width, height];
    }

    // If the image has intrinsic proportions, it's stretched to the specified dimension.
    // The unspecified dimension is computed using the specified dimension and the intrinsic proportions.
    if (hasIntrinsicProportion) {
        let width = 0;
        let height = 0;
        if (isLengthPercentage(first)) {
            width = getAbsoluteValue(first, bounds.width);
        } else if (isLengthPercentage(second)) {
            height = getAbsoluteValue(second, bounds.height);
        }

        if (isAuto(first)) {
            width = height * (intrinsicProportion as number);
        } else if (!second || isAuto(second)) {
            height = width / (intrinsicProportion as number);
        }

        return [width, height];
    }

    // If the image has no intrinsic proportions, it's stretched to the specified dimension.
    // The unspecified dimension is computed using the image's corresponding intrinsic dimension,
    // if there is one. If there is no such intrinsic dimension,
    // it becomes the corresponding dimension of the mask positioning area.

    let width = null;
    let height = null;

    if (isLengthPercentage(first)) {
        width = getAbsoluteValue(first, bounds.width);
    } else if (second && isLengthPercentage(second)) {
        height = getAbsoluteValue(second, bounds.height);
    }

    if (width !== null && (!second || isAuto(second))) {
        height =
            hasIntrinsicWidth && hasIntrinsicHeight
                ? (width / (intrinsicWidth as number)) * (intrinsicHeight as number)
                : bounds.height;
    }

    if (height !== null && isAuto(first)) {
        width =
            hasIntrinsicWidth && hasIntrinsicHeight
                ? (height / (intrinsicHeight as number)) * (intrinsicWidth as number)
                : bounds.width;
    }

    if (width !== null && height !== null) {
        return [width, height];
    }

    throw new Error(`Unable to calculate mask-size for element`);
};

export const getMaskValueForIndex = <T>(values: T[], index: number): T => {
    const value = values[index];
    if (typeof value === 'undefined') {
        return values[0];
    }

    return value;
};

export const calculateMaskRepeatPath = (
    repeat: MASK_REPEAT,
    [x, y]: [number, number],
    [width, height]: [number, number],
    maskPositioningArea: Bounds,
    maskPaintingArea: Bounds
): [Vector, Vector, Vector, Vector] => {
    switch (repeat) {
        case MASK_REPEAT.REPEAT_X:
            return [
                new Vector(Math.round(maskPositioningArea.left), Math.round(maskPositioningArea.top + y)),
                new Vector(
                    Math.round(maskPositioningArea.left + maskPositioningArea.width),
                    Math.round(maskPositioningArea.top + y)
                ),
                new Vector(
                    Math.round(maskPositioningArea.left + maskPositioningArea.width),
                    Math.round(height + maskPositioningArea.top + y)
                ),
                new Vector(Math.round(maskPositioningArea.left), Math.round(height + maskPositioningArea.top + y))
            ];
        case MASK_REPEAT.REPEAT_Y:
            return [
                new Vector(Math.round(maskPositioningArea.left + x), Math.round(maskPositioningArea.top)),
                new Vector(Math.round(maskPositioningArea.left + x + width), Math.round(maskPositioningArea.top)),
                new Vector(
                    Math.round(maskPositioningArea.left + x + width),
                    Math.round(maskPositioningArea.height + maskPositioningArea.top)
                ),
                new Vector(
                    Math.round(maskPositioningArea.left + x),
                    Math.round(maskPositioningArea.height + maskPositioningArea.top)
                )
            ];
        case MASK_REPEAT.NO_REPEAT:
            return [
                new Vector(Math.round(maskPositioningArea.left + x), Math.round(maskPositioningArea.top + y)),
                new Vector(Math.round(maskPositioningArea.left + x + width), Math.round(maskPositioningArea.top + y)),
                new Vector(
                    Math.round(maskPositioningArea.left + x + width),
                    Math.round(maskPositioningArea.top + y + height)
                ),
                new Vector(Math.round(maskPositioningArea.left + x), Math.round(maskPositioningArea.top + y + height))
            ];
        default:
            return [
                new Vector(Math.round(maskPaintingArea.left), Math.round(maskPaintingArea.top)),
                new Vector(
                    Math.round(maskPaintingArea.left + maskPaintingArea.width),
                    Math.round(maskPaintingArea.top)
                ),
                new Vector(
                    Math.round(maskPaintingArea.left + maskPaintingArea.width),
                    Math.round(maskPaintingArea.height + maskPaintingArea.top)
                ),
                new Vector(
                    Math.round(maskPaintingArea.left),
                    Math.round(maskPaintingArea.height + maskPaintingArea.top)
                )
            ];
    }
};
