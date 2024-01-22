import {IPropertyListDescriptor, PropertyDescriptorParsingType} from '../IPropertyDescriptor';
import {CSSValue, isIdentToken, parseFunctionArgs} from '../syntax/parser';
import {isLengthPercentage, LengthPercentage} from '../types/length-percentage';
import {StringValueToken} from '../syntax/tokenizer';
import {Context} from '../../core/context';

export enum MASK_SIZE {
    AUTO = 'auto',
    CONTAIN = 'contain',
    COVER = 'cover'
}

export type MaskSizeInfo = LengthPercentage | StringValueToken;
export type MaskSize = MaskSizeInfo[][];

export const maskSize: IPropertyListDescriptor<MaskSize> = {
    name: 'mask-size',
    initialValue: '0',
    prefix: false,
    type: PropertyDescriptorParsingType.LIST,
    parse: (_context: Context, tokens: CSSValue[]): MaskSize => {
        return parseFunctionArgs(tokens).map((values) => values.filter(isMaskSizeInfoToken));
    }
};

const isMaskSizeInfoToken = (value: CSSValue): value is MaskSizeInfo =>
    isIdentToken(value) || isLengthPercentage(value);
