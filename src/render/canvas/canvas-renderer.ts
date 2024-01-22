import {ElementPaint, parseStackingContexts, StackingContext} from '../stacking-context';
import {asString, Color, isTransparent} from '../../css/types/color';
import {ElementContainer, FLAGS} from '../../dom/element-container';
import {BORDER_STYLE} from '../../css/property-descriptors/border-style';
import {CSSParsedDeclaration} from '../../css';
import {TextContainer} from '../../dom/text-container';
import {Path, transformPath} from '../path';
import {BACKGROUND_CLIP} from '../../css/property-descriptors/background-clip';
import {BoundCurves, calculateBorderBoxPath, calculateContentBoxPath, calculatePaddingBoxPath} from '../bound-curves';
import {BezierCurve, isBezierCurve} from '../bezier-curve';
import {Vector} from '../vector';
import {CSSImageType, CSSURLImage, isLinearGradient, isRadialGradient} from '../../css/types/image';
import {
    parsePathForBorder,
    parsePathForBorderDoubleInner,
    parsePathForBorderDoubleOuter,
    parsePathForBorderStroke
} from '../border';
import {
    calculateBackgroundRendering,
    calculateTempBackgroundRendering,
    getBackgroundValueForIndex
} from '../background';
import {isDimensionToken} from '../../css/syntax/parser';
import {segmentGraphemes, TextBounds} from '../../css/layout/text';
import {ImageElementContainer} from '../../dom/replaced-elements/image-element-container';
import {contentBox} from '../box-sizing';
import {CanvasElementContainer} from '../../dom/replaced-elements/canvas-element-container';
import {SVGElementContainer} from '../../dom/replaced-elements/svg-element-container';
import {ReplacedElementContainer} from '../../dom/replaced-elements';
import {EffectTarget, IElementEffect, isClipEffect, isOpacityEffect, isTransformEffect} from '../effects';
import {contains} from '../../core/bitwise';
import {calculateGradientDirection, calculateRadius, processColorStops} from '../../css/types/functions/gradient';
import {FIFTY_PERCENT, getAbsoluteValue} from '../../css/types/length-percentage';
import {TEXT_DECORATION_LINE} from '../../css/property-descriptors/text-decoration-line';
import {FontMetrics} from '../font-metrics';
import {DISPLAY} from '../../css/property-descriptors/display';
import {Bounds} from '../../css/layout/bounds';
import {LIST_STYLE_TYPE} from '../../css/property-descriptors/list-style-type';
import {computeLineHeight} from '../../css/property-descriptors/line-height';
import {CHECKBOX, INPUT_COLOR, InputElementContainer, RADIO} from '../../dom/replaced-elements/input-element-container';
import {TEXT_ALIGN} from '../../css/property-descriptors/text-align';
import {TextareaElementContainer} from '../../dom/elements/textarea-element-container';
import {SelectElementContainer} from '../../dom/elements/select-element-container';
import {IFrameElementContainer} from '../../dom/replaced-elements/iframe-element-container';
import {TextShadow} from '../../css/property-descriptors/text-shadow';
import {PAINT_ORDER_LAYER} from '../../css/property-descriptors/paint-order';
import {Renderer} from '../renderer';
import {Context} from '../../core/context';
import {DIRECTION} from '../../css/property-descriptors/direction';
import {calculateMaskRendering} from '../mask';

export type RenderConfigurations = RenderOptions & {
    backgroundColor: Color | null;
};

export interface RenderOptions {
    scale: number;
    canvas?: HTMLCanvasElement;
    x: number;
    y: number;
    width: number;
    height: number;
}

const MASK_OFFSET = 10000;

export class CanvasRenderer extends Renderer {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    private readonly _activeEffects: IElementEffect[] = [];
    private readonly fontMetrics: FontMetrics;
    readonly options: RenderConfigurations;

    constructor(context: Context, options: RenderConfigurations) {
        super(context, options);
        this.options = options;
        this.canvas = options.canvas ? options.canvas : document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
        if (!options.canvas) {
            this.canvas.width = Math.floor(options.width * options.scale);
            this.canvas.height = Math.floor(options.height * options.scale);
            this.canvas.style.width = `${options.width}px`;
            this.canvas.style.height = `${options.height}px`;
        }
        this.fontMetrics = new FontMetrics(document);
        this.ctx.scale(this.options.scale, this.options.scale);
        this.ctx.translate(-options.x, -options.y);
        this.ctx.textBaseline = 'bottom';
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
        this._activeEffects = [];
        this.context.logger.debug(
            `Canvas renderer initialized (${options.width}x${options.height}) with scale ${options.scale}`
        );
    }

    applyEffects(effects: IElementEffect[]): void {
        while (this._activeEffects.length) {
            this.popEffect();
        }

        effects.forEach((effect) => this.applyEffect(effect));
    }

    applyEffect(effect: IElementEffect): void {
        this.ctx.save();
        if (isOpacityEffect(effect)) {
            this.ctx.globalAlpha = effect.opacity;
        }

        if (isTransformEffect(effect)) {
            this.ctx.translate(effect.offsetX, effect.offsetY);
            this.ctx.transform(
                effect.matrix[0],
                effect.matrix[1],
                effect.matrix[2],
                effect.matrix[3],
                effect.matrix[4],
                effect.matrix[5]
            );
            this.ctx.translate(-effect.offsetX, -effect.offsetY);
        }

        if (isClipEffect(effect)) {
            this.path(effect.path);
            this.ctx.clip();
        }

        this._activeEffects.push(effect);
    }

    popEffect(): void {
        this._activeEffects.pop();
        this.ctx.restore();
    }

    async renderStack(stack: StackingContext): Promise<void> {
        const styles = stack.element.container.styles;
        if (styles.isVisible()) {
            await this.renderStackContent(stack);
        }
    }

    async renderNode(paint: ElementPaint): Promise<void> {
        if (contains(paint.container.flags, FLAGS.DEBUG_RENDER)) {
            debugger;
        }

        if (paint.container.styles.isVisible()) {
            await this.renderNodeBackgroundAndBorders(paint);
            await this.renderNodeContent(paint);
        }
    }

    renderTextWithLetterSpacing(text: TextBounds, letterSpacing: number, baseline: number): void {
        if (letterSpacing === 0) {
            this.ctx.fillText(text.text, text.bounds.left, text.bounds.top + baseline);
        } else {
            const letters = segmentGraphemes(text.text);
            letters.reduce((left, letter) => {
                this.ctx.fillText(letter, left, text.bounds.top + baseline);

                return left + this.ctx.measureText(letter).width;
            }, text.bounds.left);
        }
    }

    private createFontStyle(styles: CSSParsedDeclaration): string[] {
        const fontVariant = styles.fontVariant
            .filter((variant) => variant === 'normal' || variant === 'small-caps')
            .join('');
        const fontFamily = fixIOSSystemFonts(styles.fontFamily).join(', ');
        const fontSize = isDimensionToken(styles.fontSize)
            ? `${styles.fontSize.number}${styles.fontSize.unit}`
            : `${styles.fontSize.number}px`;

        return [
            [styles.fontStyle, fontVariant, styles.fontWeight, fontSize, fontFamily].join(' '),
            fontFamily,
            fontSize
        ];
    }

    async renderTextNode(text: TextContainer, styles: CSSParsedDeclaration): Promise<void> {
        const [font, fontFamily, fontSize] = this.createFontStyle(styles);

        this.ctx.font = font;

        this.ctx.direction = styles.direction === DIRECTION.RTL ? 'rtl' : 'ltr';
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'alphabetic';
        const {baseline, middle} = this.fontMetrics.getMetrics(fontFamily, fontSize);
        const paintOrder = styles.paintOrder;

        text.textBounds.forEach((text) => {
            paintOrder.forEach((paintOrderLayer) => {
                switch (paintOrderLayer) {
                    case PAINT_ORDER_LAYER.FILL:
                        this.ctx.fillStyle = asString(styles.color);
                        this.renderTextWithLetterSpacing(text, styles.letterSpacing, baseline);
                        const textShadows: TextShadow = styles.textShadow;

                        if (textShadows.length && text.text.trim().length) {
                            textShadows
                                .slice(0)
                                .reverse()
                                .forEach((textShadow) => {
                                    this.ctx.shadowColor = asString(textShadow.color);
                                    this.ctx.shadowOffsetX = textShadow.offsetX.number * this.options.scale;
                                    this.ctx.shadowOffsetY = textShadow.offsetY.number * this.options.scale;
                                    this.ctx.shadowBlur = textShadow.blur.number;

                                    this.renderTextWithLetterSpacing(text, styles.letterSpacing, baseline);
                                });

                            this.ctx.shadowColor = '';
                            this.ctx.shadowOffsetX = 0;
                            this.ctx.shadowOffsetY = 0;
                            this.ctx.shadowBlur = 0;
                        }

                        if (styles.textDecorationLine.length) {
                            this.ctx.fillStyle = asString(styles.textDecorationColor || styles.color);
                            styles.textDecorationLine.forEach((textDecorationLine) => {
                                switch (textDecorationLine) {
                                    case TEXT_DECORATION_LINE.UNDERLINE:
                                        // Draws a line at the baseline of the font
                                        // TODO As some browsers display the line as more than 1px if the font-size is big,
                                        // need to take that into account both in position and size
                                        this.ctx.fillRect(
                                            text.bounds.left,
                                            Math.round(text.bounds.top + baseline),
                                            text.bounds.width,
                                            1
                                        );

                                        break;
                                    case TEXT_DECORATION_LINE.OVERLINE:
                                        this.ctx.fillRect(
                                            text.bounds.left,
                                            Math.round(text.bounds.top),
                                            text.bounds.width,
                                            1
                                        );
                                        break;
                                    case TEXT_DECORATION_LINE.LINE_THROUGH:
                                        // TODO try and find exact position for line-through
                                        this.ctx.fillRect(
                                            text.bounds.left,
                                            Math.ceil(text.bounds.top + middle),
                                            text.bounds.width,
                                            1
                                        );
                                        break;
                                }
                            });
                        }
                        break;
                    case PAINT_ORDER_LAYER.STROKE:
                        if (styles.webkitTextStrokeWidth && text.text.trim().length) {
                            this.ctx.strokeStyle = asString(styles.webkitTextStrokeColor);
                            this.ctx.lineWidth = styles.webkitTextStrokeWidth;
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            this.ctx.lineJoin = !!(window as any).chrome ? 'miter' : 'round';
                            this.ctx.strokeText(text.text, text.bounds.left, text.bounds.top + baseline);
                        }
                        this.ctx.strokeStyle = '';
                        this.ctx.lineWidth = 0;
                        this.ctx.lineJoin = 'miter';
                        break;
                }
            });
        });
    }

    renderReplacedElement(
        container: ReplacedElementContainer,
        curves: BoundCurves,
        image: HTMLImageElement | HTMLCanvasElement
    ): void {
        if (image && container.intrinsicWidth > 0 && container.intrinsicHeight > 0) {
            const box = contentBox(container);
            const path = calculatePaddingBoxPath(curves);
            this.path(path);
            this.ctx.save();
            this.ctx.clip();
            this.ctx.drawImage(
                image,
                0,
                0,
                container.intrinsicWidth,
                container.intrinsicHeight,
                box.left,
                box.top,
                box.width,
                box.height
            );
            this.ctx.restore();
        }
    }

    async renderNodeContent(paint: ElementPaint): Promise<void> {
        this.applyEffects(paint.getEffects(EffectTarget.CONTENT));
        const container = paint.container;
        const curves = paint.curves;
        const styles = container.styles;
        for (const child of container.textNodes) {
            await this.renderTextNode(child, styles);
        }

        if (container instanceof ImageElementContainer) {
            try {
                const image = await this.context.cache.match(container.src);
                this.renderReplacedElement(container, curves, image);
            } catch (e) {
                this.context.logger.error(`Error loading image ${container.src}`);
            }
        }

        if (container instanceof CanvasElementContainer) {
            this.renderReplacedElement(container, curves, container.canvas);
        }

        if (container instanceof SVGElementContainer) {
            try {
                const image = await this.context.cache.match(container.svg);
                this.renderReplacedElement(container, curves, image);
            } catch (e) {
                this.context.logger.error(`Error loading svg ${container.svg.substring(0, 255)}`);
            }
        }

        if (container instanceof IFrameElementContainer && container.tree) {
            const iframeRenderer = new CanvasRenderer(this.context, {
                scale: this.options.scale,
                backgroundColor: container.backgroundColor,
                x: 0,
                y: 0,
                width: container.width,
                height: container.height
            });

            const canvas = await iframeRenderer.render(container.tree);
            if (container.width && container.height) {
                this.ctx.drawImage(
                    canvas,
                    0,
                    0,
                    container.width,
                    container.height,
                    container.bounds.left,
                    container.bounds.top,
                    container.bounds.width,
                    container.bounds.height
                );
            }
        }

        if (container instanceof InputElementContainer) {
            const size = Math.min(container.bounds.width, container.bounds.height);

            if (container.type === CHECKBOX) {
                if (container.checked) {
                    this.ctx.save();
                    this.path([
                        new Vector(container.bounds.left + size * 0.39363, container.bounds.top + size * 0.79),
                        new Vector(container.bounds.left + size * 0.16, container.bounds.top + size * 0.5549),
                        new Vector(container.bounds.left + size * 0.27347, container.bounds.top + size * 0.44071),
                        new Vector(container.bounds.left + size * 0.39694, container.bounds.top + size * 0.5649),
                        new Vector(container.bounds.left + size * 0.72983, container.bounds.top + size * 0.23),
                        new Vector(container.bounds.left + size * 0.84, container.bounds.top + size * 0.34085),
                        new Vector(container.bounds.left + size * 0.39363, container.bounds.top + size * 0.79)
                    ]);

                    this.ctx.fillStyle = asString(INPUT_COLOR);
                    this.ctx.fill();
                    this.ctx.restore();
                }
            } else if (container.type === RADIO) {
                if (container.checked) {
                    this.ctx.save();
                    this.ctx.beginPath();
                    this.ctx.arc(
                        container.bounds.left + size / 2,
                        container.bounds.top + size / 2,
                        size / 4,
                        0,
                        Math.PI * 2,
                        true
                    );
                    this.ctx.fillStyle = asString(INPUT_COLOR);
                    this.ctx.fill();
                    this.ctx.restore();
                }
            }
        }

        if (isTextInputElement(container) && container.value.length) {
            const [fontFamily, fontSize] = this.createFontStyle(styles);
            const {baseline} = this.fontMetrics.getMetrics(fontFamily, fontSize);

            this.ctx.font = fontFamily;
            this.ctx.fillStyle = asString(styles.color);

            this.ctx.textBaseline = 'alphabetic';
            this.ctx.textAlign = canvasTextAlign(container.styles.textAlign);

            const bounds = contentBox(container);

            let x = 0;

            switch (container.styles.textAlign) {
                case TEXT_ALIGN.CENTER:
                    x += bounds.width / 2;
                    break;
                case TEXT_ALIGN.RIGHT:
                    x += bounds.width;
                    break;
            }

            const textBounds = bounds.add(x, 0, 0, -bounds.height / 2 + 1);

            this.ctx.save();
            this.path([
                new Vector(bounds.left, bounds.top),
                new Vector(bounds.left + bounds.width, bounds.top),
                new Vector(bounds.left + bounds.width, bounds.top + bounds.height),
                new Vector(bounds.left, bounds.top + bounds.height)
            ]);

            this.ctx.clip();
            this.renderTextWithLetterSpacing(
                new TextBounds(container.value, textBounds),
                styles.letterSpacing,
                baseline
            );
            this.ctx.restore();
            this.ctx.textBaseline = 'alphabetic';
            this.ctx.textAlign = 'left';
        }

        if (contains(container.styles.display, DISPLAY.LIST_ITEM)) {
            if (container.styles.listStyleImage !== null) {
                const img = container.styles.listStyleImage;
                if (img.type === CSSImageType.URL) {
                    let image;
                    const url = (img as CSSURLImage).url;
                    try {
                        image = await this.context.cache.match(url);
                        this.ctx.drawImage(image, container.bounds.left - (image.width + 10), container.bounds.top);
                    } catch (e) {
                        this.context.logger.error(`Error loading list-style-image ${url}`);
                    }
                }
            } else if (paint.listValue && container.styles.listStyleType !== LIST_STYLE_TYPE.NONE) {
                const [fontFamily] = this.createFontStyle(styles);

                this.ctx.font = fontFamily;
                this.ctx.fillStyle = asString(styles.color);

                this.ctx.textBaseline = 'middle';
                this.ctx.textAlign = 'right';
                const bounds = new Bounds(
                    container.bounds.left,
                    container.bounds.top + getAbsoluteValue(container.styles.paddingTop, container.bounds.width),
                    container.bounds.width,
                    computeLineHeight(styles.lineHeight, styles.fontSize.number) / 2 + 1
                );

                this.renderTextWithLetterSpacing(
                    new TextBounds(paint.listValue, bounds),
                    styles.letterSpacing,
                    computeLineHeight(styles.lineHeight, styles.fontSize.number) / 2 + 2
                );
                this.ctx.textBaseline = 'bottom';
                this.ctx.textAlign = 'left';
            }
        }
    }

    async renderStackContent(stack: StackingContext): Promise<void> {
        if (contains(stack.element.container.flags, FLAGS.DEBUG_RENDER)) {
            debugger;
        }
        // https://www.w3.org/TR/css-position-3/#painting-order
        // 1. the background and borders of the element forming the stacking context.
        await this.renderNodeBackgroundAndBorders(stack.element);
        // 2. the child stacking contexts with negative stack levels (most negative first).
        for (const child of stack.negativeZIndex) {
            await this.renderStack(child);
        }
        // 3. For all its in-flow, non-positioned, block-level descendants in tree order:
        await this.renderNodeContent(stack.element);

        for (const child of stack.nonInlineLevel) {
            await this.renderNode(child);
        }
        // 4. All non-positioned floating descendants, in tree order. For each one of these,
        // treat the element as if it created a new stacking context, but any positioned descendants and descendants
        // which actually create a new stacking context should be considered part of the parent stacking context,
        // not this new one.
        for (const child of stack.nonPositionedFloats) {
            await this.renderStack(child);
        }
        // 5. the in-flow, inline-level, non-positioned descendants, including inline tables and inline blocks.
        for (const child of stack.nonPositionedInlineLevel) {
            await this.renderStack(child);
        }
        for (const child of stack.inlineLevel) {
            await this.renderNode(child);
        }
        // 6. All positioned, opacity or transform descendants, in tree order that fall into the following categories:
        //  All positioned descendants with 'z-index: auto' or 'z-index: 0', in tree order.
        //  For those with 'z-index: auto', treat the element as if it created a new stacking context,
        //  but any positioned descendants and descendants which actually create a new stacking context should be
        //  considered part of the parent stacking context, not this new one. For those with 'z-index: 0',
        //  treat the stacking context generated atomically.
        //
        //  All opacity descendants with opacity less than 1
        //
        //  All transform descendants with transform other than none
        for (const child of stack.zeroOrAutoZIndexOrTransformedOrOpacity) {
            await this.renderStack(child);
        }
        // 7. Stacking contexts formed by positioned descendants with z-indices greater than or equal to 1 in z-index
        // order (smallest first) then tree order.
        for (const child of stack.positiveZIndex) {
            await this.renderStack(child);
        }
    }

    mask(paths: Path[]): void {
        this.ctx.beginPath();
        this.ctx.moveTo(0, 0);
        this.ctx.lineTo(this.canvas.width, 0);
        this.ctx.lineTo(this.canvas.width, this.canvas.height);
        this.ctx.lineTo(0, this.canvas.height);
        this.ctx.lineTo(0, 0);
        this.formatPath(paths.slice(0).reverse());
        this.ctx.closePath();
    }

    path(paths: Path[], tempCtx?: CanvasRenderingContext2D): void {
        const curCtx = tempCtx || this.ctx;
        curCtx.beginPath();
        this.formatPath(paths, curCtx);
        curCtx.closePath();
    }

    formatPath(paths: Path[], tempCtx?: CanvasRenderingContext2D): void {
        const curCtx = tempCtx || this.ctx;
        paths.forEach((point, index) => {
            const start: Vector = isBezierCurve(point) ? point.start : point;
            if (index === 0) {
                curCtx.moveTo(start.x, start.y);
            } else {
                curCtx.lineTo(start.x, start.y);
            }

            if (isBezierCurve(point)) {
                curCtx.bezierCurveTo(
                    point.startControl.x,
                    point.startControl.y,
                    point.endControl.x,
                    point.endControl.y,
                    point.end.x,
                    point.end.y
                );
            }
        });
    }

    renderRepeat(
        path: Path[],
        pattern: CanvasPattern | CanvasGradient,
        offsetX: number,
        offsetY: number,
        tempCtx?: CanvasRenderingContext2D
    ): void {
        const curCtx = tempCtx || this.ctx;
        this.path(path, curCtx);
        curCtx.fillStyle = pattern;
        curCtx.translate(offsetX, offsetY);
        curCtx.fill();
        curCtx.translate(-offsetX, -offsetY);
    }

    resizeImage(image: HTMLImageElement, width: number, height: number): HTMLCanvasElement | HTMLImageElement {
        if (image.width === width && image.height === height) {
            return image;
        }

        const ownerDocument = this.canvas.ownerDocument ?? document;
        const canvas = ownerDocument.createElement('canvas');
        canvas.width = Math.max(1, width);
        canvas.height = Math.max(1, height);
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
        ctx.drawImage(image, 0, 0, image.width, image.height, 0, 0, width, height);
        return canvas;
    }

    crCalculateBlend(a1: number, a2: number, c1: number, c2: number): number {
        return (c1 * a1 * (1 - a2) + c2 * a2) / (a1 + a2 - a1 * a2);
    }

    // cor2叠加在cor1上
    crColorBlend(
        cor1: [number, number, number, number],
        cor2: [number, number, number, number]
    ): [number, number, number, number] {
        const fAlp1 = cor1[3] / 255;
        const fAlp2 = cor2[3] / 255;
        const fAlpBlend = fAlp1 + fAlp2 - fAlp1 * fAlp2;

        const fRed1 = cor1[0] / 255;
        const fRed2 = cor2[0] / 255;
        const fRedBlend = this.crCalculateBlend(fAlp1, fAlp2, fRed1, fRed2);

        const fGreen1 = cor1[1] / 255;
        const fGreen2 = cor2[1] / 255;
        const fGreenBlend = this.crCalculateBlend(fAlp1, fAlp2, fGreen1, fGreen2);

        const fBlue1 = cor1[2] / 255;
        const fBlue2 = cor2[2] / 255;
        const fBlueBlend = this.crCalculateBlend(fAlp1, fAlp2, fBlue1, fBlue2);
        return [fRedBlend * 255, fGreenBlend * 255, fBlueBlend * 255, fAlpBlend * 255];
    }

    getDataImage(position: Vector, sw: number, sh: number): ImageData {
        return this.ctx.getImageData(
            (position.x - this.options.x) * this.options.scale,
            (position.y - this.options.y) * this.options.scale,
            sw * this.options.scale,
            sh * this.options.scale
        );
    }

    putImageData(position: Vector, imageData: ImageData): void {
        this.ctx.putImageData(imageData, position.x, position.y);
    }

    clearRect(position: Vector, sw: number, sh: number): void {
        this.ctx.clearRect(position.x, position.y, sw, sh);
        // this.ctx.beginPath();
    }

    renderTempBackgroundColor(tempCanvas: HTMLCanvasElement, backgroundColor: number): void {
        if (!isTransparent(backgroundColor)) {
            const tempCanvasContext = tempCanvas.getContext('2d') as CanvasRenderingContext2D;
            tempCanvasContext.fillStyle = asString(backgroundColor);
            tempCanvasContext.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
        }
    }

    async renderTempBackgroundImage(tempCanvas: HTMLCanvasElement, container: ElementContainer): Promise<void> {
        const tempCanvasContext = tempCanvas.getContext('2d') as CanvasRenderingContext2D;
        let index = container.styles.backgroundImage.length - 1;
        for (const backgroundImage of container.styles.backgroundImage.slice(0).reverse()) {
            if (backgroundImage.type === CSSImageType.URL) {
                let image;
                const url = (backgroundImage as CSSURLImage).url;
                try {
                    image = await this.context.cache.match(url);
                } catch (e) {
                    this.context.logger.error(`Error loading background-image ${url}`);
                }
                if (image) {
                    const [path, x, y, width, height] = calculateTempBackgroundRendering(container, index, [
                        image.width,
                        image.height,
                        image.width / image.height
                    ]);
                    const pattern = this.ctx.createPattern(
                        this.resizeImage(image, width, height),
                        'repeat'
                    ) as CanvasPattern;
                    tempCanvasContext.beginPath();
                    path.forEach((point, index) => {
                        const start: Vector = isBezierCurve(point) ? point.start : point;
                        if (index === 0) {
                            tempCanvasContext.moveTo(start.x, start.y);
                        } else {
                            tempCanvasContext.lineTo(start.x, start.y);
                        }

                        if (isBezierCurve(point)) {
                            tempCanvasContext.bezierCurveTo(
                                point.startControl.x,
                                point.startControl.y,
                                point.endControl.x,
                                point.endControl.y,
                                point.end.x,
                                point.end.y
                            );
                            debugger;
                        }
                    });
                    tempCanvasContext.closePath();
                    tempCanvasContext.fillStyle = pattern;
                    tempCanvasContext.translate(x, y);
                    tempCanvasContext.fill();
                    tempCanvasContext.translate(x, y);
                }
            } else if (isLinearGradient(backgroundImage)) {
                const [path, x, y, width, height] = calculateTempBackgroundRendering(container, index, [
                    null,
                    null,
                    null
                ]);
                const [lineLength, x0, x1, y0, y1] = calculateGradientDirection(backgroundImage.angle, width, height);

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
                const gradient = ctx.createLinearGradient(x0, y0, x1, y1);

                processColorStops(backgroundImage.stops, lineLength).forEach((colorStop) =>
                    gradient.addColorStop(colorStop.stop, asString(colorStop.color))
                );

                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, width, height);
                if (width > 0 && height > 0) {
                    const pattern = ctx.createPattern(canvas, 'repeat') as CanvasPattern;
                    this.renderRepeat(path, pattern, x, y, tempCanvasContext);
                }
            } else if (isRadialGradient(backgroundImage)) {
                const [path, left, top, width, height] = calculateTempBackgroundRendering(container, index, [
                    null,
                    null,
                    null
                ]);
                const position = backgroundImage.position.length === 0 ? [FIFTY_PERCENT] : backgroundImage.position;
                const x = getAbsoluteValue(position[0], width);
                const y = getAbsoluteValue(position[position.length - 1], height);

                const [rx, ry] = calculateRadius(backgroundImage, x, y, width, height);
                if (rx > 0 && ry > 0) {
                    const radialGradient = this.ctx.createRadialGradient(left + x, top + y, 0, left + x, top + y, rx);

                    processColorStops(backgroundImage.stops, rx * 2).forEach((colorStop) =>
                        radialGradient.addColorStop(colorStop.stop, asString(colorStop.color))
                    );

                    this.path(path, tempCanvasContext);
                    tempCanvasContext.fillStyle = radialGradient;
                    if (rx !== ry) {
                        // transforms for elliptical radial gradient
                        const midX = container.bounds.left + 0.5 * container.bounds.width;
                        const midY = container.bounds.top + 0.5 * container.bounds.height;
                        const f = ry / rx;
                        const invF = 1 / f;

                        tempCanvasContext.save();
                        tempCanvasContext.translate(midX, midY);
                        tempCanvasContext.transform(1, 0, 0, f, 0, 0);
                        tempCanvasContext.translate(-midX, -midY);

                        tempCanvasContext.fillRect(left, invF * (top - midY) + midY, width, height * invF);
                        tempCanvasContext.restore();
                    } else {
                        tempCanvasContext.fill();
                    }
                }
            }
            index--;
        }
    }

    async renderTempBackgroundMask(
        tempCanvas: HTMLCanvasElement,
        container: ElementContainer,
        backgroundWidth: number,
        backGroundHeight: number
    ): Promise<void> {
        if (container.styles.maskImage.length === 0) return;
        const tempCanvasContext = tempCanvas.getContext('2d') as CanvasRenderingContext2D;
        // 获背景图片数据
        const newImage = tempCanvasContext.getImageData(0, 0, backgroundWidth, backGroundHeight);
        const newImageData = newImage.data;
        // 清空图片，绘制遮罩
        tempCanvas.width = backgroundWidth;
        let index = container.styles.maskImage.length - 1;
        for (const maskImage of container.styles.maskImage.slice(0).reverse()) {
            if (maskImage.type === CSSImageType.URL) {
                let image;
                const url = (maskImage as CSSURLImage).url;
                try {
                    image = await this.context.cache.match(url);
                } catch (e) {
                    this.context.logger.error(`Error loading mask-image ${url}`);
                }
                if (image) {
                    const [path, x, y, width, height] = calculateMaskRendering(container, index, [
                        image.width,
                        image.height,
                        image.width / image.height
                    ]);
                    const pattern = tempCanvasContext.createPattern(
                        this.resizeImage(image, width, height),
                        'repeat'
                    ) as CanvasPattern;
                    this.renderRepeat(path, pattern, x, y, tempCanvasContext);
                }
            }
            index--;
        }
        // 合并遮罩
        const maskDataImage = tempCanvasContext.getImageData(0, 0, backgroundWidth, backGroundHeight);
        const maskImageData = maskDataImage.data;
        if (container.styles.maskImage.length > 0) {
            for (let i = 0; i < newImageData.length; i += 4) {
                newImageData[i + 3] = maskImageData[i + 3];
            }
        }
        tempCanvas.width = backgroundWidth;
        tempCanvasContext.putImageData(newImage, 0, 0);
    }

    async renderBackgroundImage(container: ElementContainer): Promise<void> {
        // 绘制背景之前，保存已经绘制的
        // 获取背景的大小
        // const startPoint = backgroundPaintingArea[0] as Vector;
        // const backgroundWidth = (backgroundPaintingArea[1] as Vector).x - (backgroundPaintingArea[0] as Vector).x;
        // const backGroundHeight = (backgroundPaintingArea[2] as Vector).y - (backgroundPaintingArea[0] as Vector).y;

        // // 保存已经绘制的图片数据
        // const backgroundImage = this.getDataImage(startPoint, backgroundWidth, backGroundHeight);
        // const backgroundImageData = backgroundImage.data;

        let index = container.styles.backgroundImage.length - 1;
        for (const backgroundImage of container.styles.backgroundImage.slice(0).reverse()) {
            if (backgroundImage.type === CSSImageType.URL) {
                let image;
                const url = (backgroundImage as CSSURLImage).url;
                try {
                    image = await this.context.cache.match(url);
                } catch (e) {
                    this.context.logger.error(`Error loading background-image ${url}`);
                }
                if (image) {
                    const [path, x, y, width, height] = calculateBackgroundRendering(container, index, [
                        image.width,
                        image.height,
                        image.width / image.height
                    ]);
                    const pattern = this.ctx.createPattern(
                        this.resizeImage(image, width, height),
                        'repeat'
                    ) as CanvasPattern;
                    this.renderRepeat(path, pattern, x, y);
                    // 绘制遮罩
                    // if (container.styles.maskImage.length > 0) {
                    //     // 获取背景的大小
                    //     const startPoint = backgroundPaintingArea[0] as Vector;
                    //     const backgroundWidth =
                    //         (backgroundPaintingArea[1] as Vector).x - (backgroundPaintingArea[0] as Vector).x;
                    //     const backGroundHeight =
                    //         (backgroundPaintingArea[2] as Vector).y - (backgroundPaintingArea[0] as Vector).y;

                    //     // 保存已经绘制的图片数据
                    //     const backgroundImage = this.getDataImage(startPoint, backgroundWidth, backGroundHeight);
                    //     const backgroundImageData = backgroundImage.data;
                    //     // 清空绘制区域
                    //     this.clearRect(startPoint, backgroundWidth, backGroundHeight);
                    //     // 绘制需要绘制的新图片
                    //     this.renderRepeat(path, pattern, x, y);
                    //     const newImage = this.getDataImage(startPoint, backgroundWidth, backGroundHeight);
                    //     const newImageData = newImage.data;
                    //     // 清空绘制区域
                    //     this.clearRect(startPoint, backgroundWidth, backGroundHeight);
                    //     // 绘制遮罩
                    //     let maskImage;
                    //     const url = (container.styles.maskImage[0] as CSSURLImage).url;
                    //     try {
                    //         maskImage = await this.context.cache.match(url);
                    //     } catch (e) {
                    //         this.context.logger.error(`Error loading mask-image ${url}`);
                    //     }
                    //     const [maskPath, maskX, maskY, maskWidth, maskHeight] = calculateMaskRendering(
                    //         container,
                    //         index,
                    //         [maskImage.width, maskImage.height, maskImage.width / maskImage.height]
                    //     );
                    //     const maskPattern = this.ctx.createPattern(
                    //         this.resizeImage(maskImage, maskWidth, maskHeight),
                    //         'repeat'
                    //     ) as CanvasPattern;
                    //     // this.renderRepeat(maskPath, maskPattern, maskX, maskY);
                    //     const maskDataImage = this.getDataImage(startPoint, backgroundWidth, backGroundHeight);
                    //     const maskImageData = maskDataImage.data;
                    //     if (backgroundImageData && newImageData && maskImageData) {
                    //         for (let i = 0; i < newImageData.length; i += 4) {
                    //             newImageData[i + 3] = maskImageData[i + 3];
                    //             if (newImageData[i + 3] === 0) {
                    //                 newImageData[i] = backgroundImageData[i];
                    //                 newImageData[i + 1] = backgroundImageData[i + 1];
                    //                 newImageData[i + 2] = backgroundImageData[i + 2];
                    //                 newImageData[i + 3] = backgroundImageData[i + 3];
                    //             } else if (newImageData[i + 3] !== 255) {
                    //                 const newData = this.crColorBlend(
                    //                     [
                    //                         backgroundImageData[i],
                    //                         backgroundImageData[i + 1],
                    //                         backgroundImageData[i + 2],
                    //                         backgroundImageData[i + 3]
                    //                     ],
                    //                     [newImageData[i], newImageData[i + 1], newImageData[i + 2], newImageData[i + 3]]
                    //                 );
                    //                 newImageData[i] = newData[0];
                    //                 newImageData[i + 1] = newData[1];
                    //                 newImageData[i + 2] = newData[2];
                    //                 newImageData[i + 3] = newData[3];
                    //             }
                    //         }
                    //     }
                    //     // this.clearRect(startPoint, backgroundWidth, backGroundHeight);
                    //     // this.putImageData(startPoint, newImage);
                    // } else {
                    //     this.renderRepeat(path, pattern, x, y);
                    // }
                }
            } else if (isLinearGradient(backgroundImage)) {
                const [path, x, y, width, height] = calculateBackgroundRendering(container, index, [null, null, null]);
                const [lineLength, x0, x1, y0, y1] = calculateGradientDirection(backgroundImage.angle, width, height);

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
                const gradient = ctx.createLinearGradient(x0, y0, x1, y1);

                processColorStops(backgroundImage.stops, lineLength).forEach((colorStop) =>
                    gradient.addColorStop(colorStop.stop, asString(colorStop.color))
                );

                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, width, height);
                if (width > 0 && height > 0) {
                    const pattern = this.ctx.createPattern(canvas, 'repeat') as CanvasPattern;
                    this.renderRepeat(path, pattern, x, y);
                }
            } else if (isRadialGradient(backgroundImage)) {
                const [path, left, top, width, height] = calculateBackgroundRendering(container, index, [
                    null,
                    null,
                    null
                ]);
                const position = backgroundImage.position.length === 0 ? [FIFTY_PERCENT] : backgroundImage.position;
                const x = getAbsoluteValue(position[0], width);
                const y = getAbsoluteValue(position[position.length - 1], height);

                const [rx, ry] = calculateRadius(backgroundImage, x, y, width, height);
                if (rx > 0 && ry > 0) {
                    const radialGradient = this.ctx.createRadialGradient(left + x, top + y, 0, left + x, top + y, rx);

                    processColorStops(backgroundImage.stops, rx * 2).forEach((colorStop) =>
                        radialGradient.addColorStop(colorStop.stop, asString(colorStop.color))
                    );

                    this.path(path);
                    this.ctx.fillStyle = radialGradient;
                    if (rx !== ry) {
                        // transforms for elliptical radial gradient
                        const midX = container.bounds.left + 0.5 * container.bounds.width;
                        const midY = container.bounds.top + 0.5 * container.bounds.height;
                        const f = ry / rx;
                        const invF = 1 / f;

                        this.ctx.save();
                        this.ctx.translate(midX, midY);
                        this.ctx.transform(1, 0, 0, f, 0, 0);
                        this.ctx.translate(-midX, -midY);

                        this.ctx.fillRect(left, invF * (top - midY) + midY, width, height * invF);
                        this.ctx.restore();
                    } else {
                        this.ctx.fill();
                    }
                }
            }
            index--;
        }
    }

    async renderBackgroundMask(
        container: ElementContainer,
        backgroundImageData: Uint8ClampedArray,
        startPoint: Vector,
        backgroundWidth: number,
        backGroundHeight: number
    ): Promise<void> {
        if (container.styles.maskImage.length === 0) return;
        // 先获取已经绘制的背景图
        const newImage = this.getDataImage(startPoint, backgroundWidth, backGroundHeight);
        const newImageData = newImage.data;
        // 清空图片，绘制遮罩
        this.clearRect(startPoint, backgroundWidth, backGroundHeight);
        let index = container.styles.maskImage.length - 1;
        for (const maskImage of container.styles.maskImage.slice(0).reverse()) {
            if (maskImage.type === CSSImageType.URL) {
                let image;
                const url = (maskImage as CSSURLImage).url;
                try {
                    image = await this.context.cache.match(url);
                } catch (e) {
                    this.context.logger.error(`Error loading mask-image ${url}`);
                }
                if (image) {
                    const [path, x, y, width, height] = calculateMaskRendering(container, index, [
                        image.width,
                        image.height,
                        image.width / image.height
                    ]);
                    const pattern = this.ctx.createPattern(
                        this.resizeImage(image, width, height),
                        'repeat'
                    ) as CanvasPattern;
                    this.renderRepeat(path, pattern, x, y);
                }
            }
            index--;
        }
        const maskDataImage = this.getDataImage(startPoint, backgroundWidth, backGroundHeight);
        const maskImageData = maskDataImage.data;
        if (container.styles.maskImage.length > 0) {
            for (let i = 0; i < newImageData.length; i += 4) {
                newImageData[i + 3] = maskImageData[i + 3];
                if (newImageData[i + 3] === 0) {
                    newImageData[i] = backgroundImageData[i];
                    newImageData[i + 1] = backgroundImageData[i + 1];
                    newImageData[i + 2] = backgroundImageData[i + 2];
                    newImageData[i + 3] = backgroundImageData[i + 3];
                } else if (newImageData[i + 3] !== 255) {
                    const newData = this.crColorBlend(
                        [
                            backgroundImageData[i],
                            backgroundImageData[i + 1],
                            backgroundImageData[i + 2],
                            backgroundImageData[i + 3]
                        ],
                        [newImageData[i], newImageData[i + 1], newImageData[i + 2], newImageData[i + 3]]
                    );
                    newImageData[i] = newData[0];
                    newImageData[i + 1] = newData[1];
                    newImageData[i + 2] = newData[2];
                    newImageData[i + 3] = newData[3];
                }
            }
        }
        // this.putImageData(startPoint, newImage);
    }

    async renderSolidBorder(color: Color, side: number, curvePoints: BoundCurves): Promise<void> {
        this.path(parsePathForBorder(curvePoints, side));
        this.ctx.fillStyle = asString(color);
        this.ctx.fill();
    }

    async renderDoubleBorder(color: Color, width: number, side: number, curvePoints: BoundCurves): Promise<void> {
        if (width < 3) {
            await this.renderSolidBorder(color, side, curvePoints);
            return;
        }

        const outerPaths = parsePathForBorderDoubleOuter(curvePoints, side);
        this.path(outerPaths);
        this.ctx.fillStyle = asString(color);
        this.ctx.fill();
        const innerPaths = parsePathForBorderDoubleInner(curvePoints, side);
        this.path(innerPaths);
        this.ctx.fill();
    }

    async renderNodeBackgroundAndBorders(paint: ElementPaint): Promise<void> {
        this.applyEffects(paint.getEffects(EffectTarget.BACKGROUND_BORDERS));
        const styles = paint.container.styles;
        const hasBackground = !isTransparent(styles.backgroundColor) || styles.backgroundImage.length;

        const borders = [
            {style: styles.borderTopStyle, color: styles.borderTopColor, width: styles.borderTopWidth},
            {style: styles.borderRightStyle, color: styles.borderRightColor, width: styles.borderRightWidth},
            {style: styles.borderBottomStyle, color: styles.borderBottomColor, width: styles.borderBottomWidth},
            {style: styles.borderLeftStyle, color: styles.borderLeftColor, width: styles.borderLeftWidth}
        ];

        const backgroundPaintingArea = calculateBackgroundCurvedPaintingArea(
            getBackgroundValueForIndex(styles.backgroundClip, 0),
            paint.curves
        );

        if (hasBackground || styles.boxShadow.length) {
            this.ctx.save();
            this.path(backgroundPaintingArea);
            this.ctx.clip();
            const startPoint = backgroundPaintingArea[0] as Vector;
            const backgroundWidth = (backgroundPaintingArea[1] as Vector).x - (backgroundPaintingArea[0] as Vector).x;
            const backGroundHeight = (backgroundPaintingArea[2] as Vector).y - (backgroundPaintingArea[0] as Vector).y;
            // const backgroundImage = this.getDataImage(startPoint, backgroundWidth, backGroundHeight);
            // const backgroundImageData = backgroundImage.data;
            // this.clearRect(startPoint, backgroundWidth, backGroundHeight);
            const containerBounds = paint.container.bounds;
            const tempCanvas = this.canvas.ownerDocument.createElement('canvas');
            tempCanvas.width = containerBounds.width;
            tempCanvas.height = containerBounds.height;
            if (!isTransparent(styles.backgroundColor)) {
                this.renderTempBackgroundColor(tempCanvas, styles.backgroundColor);
                // this.ctx.strokeStyle = 'blue';
                // this.ctx.stroke();
                // const imgData = this.getDataImage(startPoint, backgroundWidth, backGroundHeight);
                // for (let i = 0; i < imgData.data.length; i += 4) {
                //     imgData.data[i + 0] = 255;
                //     imgData.data[i + 1] = 0;
                //     imgData.data[i + 2] = 0;
                //     imgData.data[i + 3] = 255;
                // }
                // this.ctx.putImageData(
                //     imgData,
                //     startPoint.x,
                //     startPoint.y
                //     // startPoint.x,
                //     // startPoint.y,
                //     // backgroundWidth,
                //     // backGroundHeight
                // );
                // this.putImageData(startPoint, imgData);
                // this.ctx.fillStyle = asString(styles.backgroundColor);
                // this.ctx.fill();
                // this.ctx.beginPath();
                // this.ctx.fillStyle = 'red';
                // this.ctx.fillRect(startPoint.x, startPoint.y, backgroundWidth, backGroundHeight);
                // this.clearRect(startPoint, backgroundWidth, backGroundHeight);
                // this.ctx.fillStyle = 'rgba(255, 255, 23, 1)';
                // this.ctx.fill();
                // 创建临时canvas
            }
            // tempCanvasContext.fillStyle = 'blue';
            // tempCanvasContext.fillRect(0, 0, backgroundWidth, backGroundHeight);
            await this.renderTempBackgroundImage(tempCanvas, paint.container);
            await this.renderTempBackgroundMask(
                tempCanvas,
                paint.container,
                containerBounds.width,
                containerBounds.height
            );
            this.ctx.drawImage(
                tempCanvas,
                containerBounds.left,
                containerBounds.top,
                containerBounds.width,
                containerBounds.height
            );

            // await this.renderBackgroundImage(paint.container);
            //清空图片，绘制遮罩
            // this.clearRect(startPoint, backgroundWidth, backGroundHeight);
            // this.ctx.fillStyle = 'rgba(0, 0, 0)';

            // await this.renderBackgroundMask(
            //     paint.container,
            //     backgroundImageData,
            //     startPoint,
            //     backgroundWidth,
            //     backGroundHeight
            // );

            this.ctx.restore();

            styles.boxShadow
                .slice(0)
                .reverse()
                .forEach((shadow) => {
                    this.ctx.save();
                    const borderBoxArea = calculateBorderBoxPath(paint.curves);
                    const maskOffset = shadow.inset ? 0 : MASK_OFFSET;
                    const shadowPaintingArea = transformPath(
                        borderBoxArea,
                        -maskOffset + (shadow.inset ? 1 : -1) * shadow.spread.number,
                        (shadow.inset ? 1 : -1) * shadow.spread.number,
                        shadow.spread.number * (shadow.inset ? -2 : 2),
                        shadow.spread.number * (shadow.inset ? -2 : 2)
                    );

                    if (shadow.inset) {
                        this.path(borderBoxArea);
                        this.ctx.clip();
                        this.mask(shadowPaintingArea);
                    } else {
                        this.mask(borderBoxArea);
                        this.ctx.clip();
                        this.path(shadowPaintingArea);
                    }

                    this.ctx.shadowOffsetX = shadow.offsetX.number + maskOffset;
                    this.ctx.shadowOffsetY = shadow.offsetY.number;
                    this.ctx.shadowColor = asString(shadow.color);
                    this.ctx.shadowBlur = shadow.blur.number;
                    this.ctx.fillStyle = shadow.inset ? asString(shadow.color) : 'rgba(0,0,0,1)';

                    this.ctx.fill();
                    this.ctx.restore();
                });
        }

        let side = 0;
        for (const border of borders) {
            if (border.style !== BORDER_STYLE.NONE && !isTransparent(border.color) && border.width > 0) {
                if (border.style === BORDER_STYLE.DASHED) {
                    await this.renderDashedDottedBorder(
                        border.color,
                        border.width,
                        side,
                        paint.curves,
                        BORDER_STYLE.DASHED
                    );
                } else if (border.style === BORDER_STYLE.DOTTED) {
                    await this.renderDashedDottedBorder(
                        border.color,
                        border.width,
                        side,
                        paint.curves,
                        BORDER_STYLE.DOTTED
                    );
                } else if (border.style === BORDER_STYLE.DOUBLE) {
                    await this.renderDoubleBorder(border.color, border.width, side, paint.curves);
                } else {
                    await this.renderSolidBorder(border.color, side, paint.curves);
                }
            }
            side++;
        }
    }

    async renderDashedDottedBorder(
        color: Color,
        width: number,
        side: number,
        curvePoints: BoundCurves,
        style: BORDER_STYLE
    ): Promise<void> {
        this.ctx.save();

        const strokePaths = parsePathForBorderStroke(curvePoints, side);
        const boxPaths = parsePathForBorder(curvePoints, side);

        if (style === BORDER_STYLE.DASHED) {
            this.path(boxPaths);
            this.ctx.clip();
        }

        let startX, startY, endX, endY;
        if (isBezierCurve(boxPaths[0])) {
            startX = (boxPaths[0] as BezierCurve).start.x;
            startY = (boxPaths[0] as BezierCurve).start.y;
        } else {
            startX = (boxPaths[0] as Vector).x;
            startY = (boxPaths[0] as Vector).y;
        }
        if (isBezierCurve(boxPaths[1])) {
            endX = (boxPaths[1] as BezierCurve).end.x;
            endY = (boxPaths[1] as BezierCurve).end.y;
        } else {
            endX = (boxPaths[1] as Vector).x;
            endY = (boxPaths[1] as Vector).y;
        }

        let length;
        if (side === 0 || side === 2) {
            length = Math.abs(startX - endX);
        } else {
            length = Math.abs(startY - endY);
        }

        this.ctx.beginPath();
        if (style === BORDER_STYLE.DOTTED) {
            this.formatPath(strokePaths);
        } else {
            this.formatPath(boxPaths.slice(0, 2));
        }

        let dashLength = width < 3 ? width * 3 : width * 2;
        let spaceLength = width < 3 ? width * 2 : width;
        if (style === BORDER_STYLE.DOTTED) {
            dashLength = width;
            spaceLength = width;
        }

        let useLineDash = true;
        if (length <= dashLength * 2) {
            useLineDash = false;
        } else if (length <= dashLength * 2 + spaceLength) {
            const multiplier = length / (2 * dashLength + spaceLength);
            dashLength *= multiplier;
            spaceLength *= multiplier;
        } else {
            const numberOfDashes = Math.floor((length + spaceLength) / (dashLength + spaceLength));
            const minSpace = (length - numberOfDashes * dashLength) / (numberOfDashes - 1);
            const maxSpace = (length - (numberOfDashes + 1) * dashLength) / numberOfDashes;
            spaceLength =
                maxSpace <= 0 || Math.abs(spaceLength - minSpace) < Math.abs(spaceLength - maxSpace)
                    ? minSpace
                    : maxSpace;
        }

        if (useLineDash) {
            if (style === BORDER_STYLE.DOTTED) {
                this.ctx.setLineDash([0, dashLength + spaceLength]);
            } else {
                this.ctx.setLineDash([dashLength, spaceLength]);
            }
        }

        if (style === BORDER_STYLE.DOTTED) {
            this.ctx.lineCap = 'round';
            this.ctx.lineWidth = width;
        } else {
            this.ctx.lineWidth = width * 2 + 1.1;
        }
        this.ctx.strokeStyle = asString(color);
        this.ctx.stroke();
        this.ctx.setLineDash([]);

        // dashed round edge gap
        if (style === BORDER_STYLE.DASHED) {
            if (isBezierCurve(boxPaths[0])) {
                const path1 = boxPaths[3] as BezierCurve;
                const path2 = boxPaths[0] as BezierCurve;
                this.ctx.beginPath();
                this.formatPath([new Vector(path1.end.x, path1.end.y), new Vector(path2.start.x, path2.start.y)]);
                this.ctx.stroke();
            }
            if (isBezierCurve(boxPaths[1])) {
                const path1 = boxPaths[1] as BezierCurve;
                const path2 = boxPaths[2] as BezierCurve;
                this.ctx.beginPath();
                this.formatPath([new Vector(path1.end.x, path1.end.y), new Vector(path2.start.x, path2.start.y)]);
                this.ctx.stroke();
            }
        }

        this.ctx.restore();
    }

    async render(element: ElementContainer): Promise<HTMLCanvasElement> {
        if (this.options.backgroundColor) {
            this.ctx.fillStyle = asString(this.options.backgroundColor);
            this.ctx.fillRect(this.options.x, this.options.y, this.options.width, this.options.height);
        }

        const stack = parseStackingContexts(element);
        // debugger;
        await this.renderStack(stack);
        this.applyEffects([]);
        return this.canvas;
    }
}

const isTextInputElement = (
    container: ElementContainer
): container is InputElementContainer | TextareaElementContainer | SelectElementContainer => {
    if (container instanceof TextareaElementContainer) {
        return true;
    } else if (container instanceof SelectElementContainer) {
        return true;
    } else if (container instanceof InputElementContainer && container.type !== RADIO && container.type !== CHECKBOX) {
        return true;
    }
    return false;
};

const calculateBackgroundCurvedPaintingArea = (clip: BACKGROUND_CLIP, curves: BoundCurves): Path[] => {
    switch (clip) {
        case BACKGROUND_CLIP.BORDER_BOX:
            return calculateBorderBoxPath(curves);
        case BACKGROUND_CLIP.CONTENT_BOX:
            return calculateContentBoxPath(curves);
        case BACKGROUND_CLIP.PADDING_BOX:
        default:
            return calculatePaddingBoxPath(curves);
    }
};

const canvasTextAlign = (textAlign: TEXT_ALIGN): CanvasTextAlign => {
    switch (textAlign) {
        case TEXT_ALIGN.CENTER:
            return 'center';
        case TEXT_ALIGN.RIGHT:
            return 'right';
        case TEXT_ALIGN.LEFT:
        default:
            return 'left';
    }
};

// see https://github.com/niklasvh/html2canvas/pull/2645
const iOSBrokenFonts = ['-apple-system', 'system-ui'];

const fixIOSSystemFonts = (fontFamilies: string[]): string[] => {
    return /iPhone OS 15_(0|1)/.test(window.navigator.userAgent)
        ? fontFamilies.filter((fontFamily) => iOSBrokenFonts.indexOf(fontFamily) === -1)
        : fontFamilies;
};
