import {IPropertyListDescriptor, PropertyDescriptorParsingType} from '../IPropertyDescriptor';
import {CSSValue, isIdentToken, parseFunctionArgs} from '../syntax/parser';
import {Context} from '../../core/context';
export type MaskRepeat = MASK_REPEAT[];

export const enum MASK_REPEAT {
    REPEAT = 0,
    NO_REPEAT = 1,
    REPEAT_X = 2,
    REPEAT_Y = 3
}

export const maskRepeat: IPropertyListDescriptor<MaskRepeat> = {
    name: 'mask-repeat',
    initialValue: 'repeat',
    prefix: false,
    type: PropertyDescriptorParsingType.LIST,
    parse: (_context: Context, tokens: CSSValue[]): MaskRepeat => {
        return parseFunctionArgs(tokens)
            .map((values) =>
                values
                    .filter(isIdentToken)
                    .map((token) => token.value)
                    .join(' ')
            )
            .map(parseMaskRepeat);
    }
};

const parseMaskRepeat = (value: string): MASK_REPEAT => {
    switch (value) {
        case 'no-repeat':
            return MASK_REPEAT.NO_REPEAT;
        case 'repeat-x':
        case 'repeat no-repeat':
            return MASK_REPEAT.REPEAT_X;
        case 'repeat-y':
        case 'no-repeat repeat':
            return MASK_REPEAT.REPEAT_Y;
        case 'repeat':
        default:
            return MASK_REPEAT.REPEAT;
    }
};
