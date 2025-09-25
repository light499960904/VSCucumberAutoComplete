export type StepSettings = string[];

export type PagesSettings = {
    [page: string]: string
};

export type CustomParameter = {
    parameter: string | RegExp,
    value: string
};

export type ParameterSymbolConfig = {
    parameterType: string,
    prefix: string,
    suffix: string
};

type FormatConfVal = number | 'relative' | 'relativeUp';

export interface FormatConf {
    [key: string]: FormatConfVal
}

export interface BaseSettings {
    steps?: StepSettings,
    pages?: PagesSettings,
    syncfeatures?: boolean | string,
    strictGherkinCompletion?: boolean,
    strictGherkinValidation?: boolean,
    smartSnippets?: boolean,
    stepsInvariants?: boolean,
    customParameters?: CustomParameter[],
    skipDocStringsFormat?: boolean,
    formatConfOverride?: FormatConf,
    onTypeFormat?: boolean,
    gherkinDefinitionPart?: string,
    stepRegExSymbol?: string,
    pureTextSteps?: boolean,
    parameterSymbols?: ParameterSymbolConfig[]
}

export interface Settings {
    steps: StepSettings,
    pages: PagesSettings,
    syncfeatures?: boolean | string,
    strictGherkinCompletion?: boolean,
    strictGherkinValidation?: boolean,
    smartSnippets?: boolean,
    stepsInvariants?: boolean,
    customParameters?: CustomParameter[],
    skipDocStringsFormat?: boolean,
    formatConfOverride?: FormatConf,
    onTypeFormat?: boolean,
    gherkinDefinitionPart?: string,
    stepRegExSymbol?: string,
    pureTextSteps?: boolean,
    parameterSymbols?: ParameterSymbolConfig[]
}
