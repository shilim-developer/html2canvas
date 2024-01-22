import {IPropertyListDescriptor, PropertyDescriptorParsingType} from '../IPropertyDescriptor';
import {CSSValue, isIdentToken} from '../syntax/parser';
import {Context} from '../../core/context';
export const enum MASK_CLIP {
    BORDER_BOX = 0,
    PADDING_BOX = 1,
    CONTENT_BOX = 2
}

export type MaskClip = MASK_CLIP[];

export const maskClip: IPropertyListDescriptor<MaskClip> = {
    name: 'mask-clip',
    initialValue: 'border-box',
    prefix: false,
    type: PropertyDescriptorParsingType.LIST,
    parse: (_context: Context, tokens: CSSValue[]): MaskClip => {
        return tokens.map((token) => {
            if (isIdentToken(token)) {
                switch (token.value) {
                    case 'padding-box':
                        return MASK_CLIP.PADDING_BOX;
                    case 'content-box':
                        return MASK_CLIP.CONTENT_BOX;
                }
            }
            return MASK_CLIP.BORDER_BOX;
        });
    }
};
