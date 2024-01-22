import {IPropertyListDescriptor, PropertyDescriptorParsingType} from '../IPropertyDescriptor';
import {CSSValue, isIdentToken} from '../syntax/parser';
import {Context} from '../../core/context';

export const enum MASK_ORIGIN {
    BORDER_BOX = 0,
    PADDING_BOX = 1,
    CONTENT_BOX = 2
}

export type MaskOrigin = MASK_ORIGIN[];

export const maskOrigin: IPropertyListDescriptor<MaskOrigin> = {
    name: 'mask-origin',
    initialValue: 'border-box',
    prefix: false,
    type: PropertyDescriptorParsingType.LIST,
    parse: (_context: Context, tokens: CSSValue[]): MaskOrigin => {
        return tokens.map((token) => {
            if (isIdentToken(token)) {
                switch (token.value) {
                    case 'padding-box':
                        return MASK_ORIGIN.PADDING_BOX;
                    case 'content-box':
                        return MASK_ORIGIN.CONTENT_BOX;
                }
            }
            return MASK_ORIGIN.BORDER_BOX;
        });
    }
};
