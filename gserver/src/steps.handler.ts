import * as glob from 'glob';
import * as commentParser from 'doctrine';

import {
    Definition,
    CompletionItem,
    Diagnostic,
    DiagnosticSeverity,
    Position,
    Location,
    Range,
    CompletionItemKind,
    InsertTextFormat,
} from 'vscode-languageserver';

import {
    getOSPath,
    getFileContent,
    clearComments,
    getMD5Id,
    escapeRegExp,
    escaprRegExpForPureText,
    getTextRange,
    getSortPrefix,
} from './util';

import {
    allGherkinWords,
    GherkinType,
    getGherkinType,
    getGherkinTypeLower,
} from './gherkin';

import { Settings, StepSettings, CustomParameter } from './types';

export type Step = {
  id: string;
  reg: RegExp;
  partialReg: RegExp;
  text: string;
  desc: string;
  def: Definition;
  count: number;
  gherkin: GherkinType;
  documentation: string;
};

export type StepsCountHash = {
  [step: string]: number;
};

interface JSDocComments {
  [key: number]: string;
}

export default class StepsHandler {
    elements: Step[] = [];

    elementsHash: { [step: string]: boolean } = {};

    elemenstCountHash: StepsCountHash = {};

    settings: Settings;

    constructor(root: string, settings: Settings) {
        const { syncfeatures, steps } = settings;
        this.settings = settings;
        this.populate(root, steps);
        if (syncfeatures === true) {
            this.setElementsHash(`${root}/**/*.feature`);
        } else if (typeof syncfeatures === 'string') {
            this.setElementsHash(`${root}/${syncfeatures}`);
        }
    }

    getGherkinRegEx() {
        return new RegExp(`^(\\s*)(${allGherkinWords})(\\s+)(.*)`);
    }

    getElements(): Step[] {
        return this.elements;
    }

    setElementsHash(path: string): void {
        this.elemenstCountHash = {};
        const files = glob.sync(path);
        files.forEach((f) => {
            const text = getFileContent(f);
            text.split(/\r?\n/g).forEach((line) => {
                const match = this.getGherkinMatch(line, text);
                if (match) {
                    const step = this.getStepByText(match[4]);
                    if (step) {
                        this.incrementElementCount(step.id);
                    }
                }
            });
        });
        this.elements.forEach((el) => (el.count = this.getElementCount(el.id)));
    }

    incrementElementCount(id: string): void {
        if (this.elemenstCountHash[id]) {
            this.elemenstCountHash[id]++;
        } else {
            this.elemenstCountHash[id] = 1;
        }
    }

    getElementCount(id: string): number {
        return this.elemenstCountHash[id] || 0;
    }

    getStepRegExp(): RegExp {
        //Actually, we dont care what the symbols are before our 'Gherkin' word
        //But they shouldn't end with letter
        const startPart = "^((?:[^'\"/]*?[^\\w])|.{0})";

        //All the steps should be declared using any gherkin keyword. We should get first 'gherkin' word
        const gherkinPart =
      this.settings.gherkinDefinitionPart ||
      `(${allGherkinWords}|defineStep|Step|StepDefinition)`;

        //All the symbols, except of symbols, using as step start and letters, could be between gherkin word and our step
        const nonStepStartSymbols = '[^/\'"`\\w]*?';

        // Step part getting
        const { stepRegExSymbol } = this.settings;
        // Step text could be placed between '/' symbols (ex. in JS) or between quotes, like in Java
        const stepStart = stepRegExSymbol ? `(${stepRegExSymbol})` : '(/|\'|"|`)';
        // ref to RegEx Example: https://regex101.com/r/mS1zJ8/1
        // Use a RegEx that peeks ahead to ensure escape character can still work, like `\'`.
        const stepBody = '((?:(?=(?:\\\\)*)\\\\.|.)*?)';
        //Step should be ended with same symbol it begins
        const stepEnd = stepRegExSymbol ? stepRegExSymbol : '\\3';

        //Our RegExp will be case-insensitive to support cases like TypeScript (...@when...)
        const r = new RegExp(
            startPart +
        gherkinPart +
        nonStepStartSymbols +
        stepStart +
        stepBody +
        stepEnd,
            'i'
        );

        // /^((?:[^'"\/]*?[^\w])|.{0})(Given|When|Then|And|But|defineStep)[^\/'"\w]*?(\/|'|")([^\3]+)\3/i
        return r;
    }

    geStepDefinitionMatch(line: string) {
        // First try the original regex
        const match = line.match(this.getStepRegExp());
        if (match) {
            return match;
        }

        // Clean up the line for better matching by removing extra whitespace and line breaks
        const cleanLine = line.replace(/\s+/g, ' ').trim();

        // Try to match ES6 destructured imports like: (0, cucumber_1.When)(`template`, callback)
        // Also handles formats with comments like: (0, cucumber_1.When)( //comment `template`, callback)
        const es6Patterns = [
            // Pattern 1: (0, cucumber_1.When)(`template`, callback)
            /^(.*?[^\w])([^\w]*(?:cucumber_[^\w]*)?)(Given|When|Then|And|But|defineStep|Step|StepDefinition)[^\w]*\)\s*\(\s*([`'"])((?:(?=(?:\\)*)\\.|.)*?)\4/i,
            
            // Pattern 2: (0, cucumber_1.When)( //comment `template`, callback) - handle comments between parentheses
            /^(.*?[^\w])([^\w]*(?:cucumber_[^\w]*)?)(Given|When|Then|And|But|defineStep|Step|StepDefinition)[^\w]*\)\s*\(\s*\/\/[^`'"]*\s*([`'"])((?:(?=(?:\\)*)\\.|.)*?)\4/i,
            
            // Pattern 3: More flexible pattern for various comment styles
            /^(.*?[^\w])([^\w]*(?:cucumber_[^\w]*)?)(Given|When|Then|And|But|defineStep|Step|StepDefinition)[^\w]*\)\s*\([^`'"]*([`'"])((?:(?=(?:\\)*)\\.|.)*?)\4/i
        ];

        for (const pattern of es6Patterns) {
            const es6Match = cleanLine.match(pattern);
            if (es6Match && es6Match[5]) { // Make sure we have a step part
                return [es6Match[0], es6Match[1] || '', es6Match[3] || '', es6Match[4] || '', es6Match[5] || ''];
            }
        }

        // Try to match CommonJS module.exports patterns: module.exports.When = function(template, callback) {}
        const commonjsMatch = cleanLine.match(/^(.*?[^\w])(module\.exports\.|exports\.)(Given|When|Then|And|But|defineStep|Step|StepDefinition)\s*=\s*function\s*\(\s*([`'"])((?:(?=(?:\\)*)\\.|.)*?)\4/i);
        if (commonjsMatch) {
            return [commonjsMatch[0], commonjsMatch[1] || '', commonjsMatch[3] || '', commonjsMatch[4] || '', commonjsMatch[5] || ''];
        }

        // Try to match Cucumber.js v7+ pattern: cucumber.When(template, callback)
        const cucumberDirectMatch = cleanLine.match(/^(.*?[^\w])(cucumber\.|Cucumber\.)(Given|When|Then|And|But|defineStep|Step|StepDefinition)\s*\(\s*([`'"])((?:(?=(?:\\)*)\\.|.)*?)\4/i);
        if (cucumberDirectMatch) {
            return [cucumberDirectMatch[0], cucumberDirectMatch[1] || '', cucumberDirectMatch[3] || '', cucumberDirectMatch[4] || '', cucumberDirectMatch[5] || ''];
        }

        // Try to match new RegExp constructor: new RegExp(`template`)
        const regexpMatch = cleanLine.match(/^(.*?new\s+RegExp\s*\(\s*)([`'"/])((?:(?=(?:\\)*)\\.|.)*?)\2/i);
        if (regexpMatch) {
            return [regexpMatch[0], regexpMatch[1] || '', '', regexpMatch[2] || '', regexpMatch[3] || ''];
        }

        return null;
    }

    getOutlineVars(text: string) {
        return text.split(/\r?\n/g).reduce((res, a, i, arr) => {
            if (a.match(/^\s*Examples:\s*$/) && arr[i + 2]) {
                const names = arr[i + 1].split(/\s*\|\s*/).slice(1, -1);
                const values = arr[i + 2].split(/\s*\|\s*/).slice(1, -1);
                names.forEach((n, i) => {
                    if (values[i]) {
                        res[n] = values[i];
                    }
                });
            }
            return res;
        }, {} as Record<string, string>);
    }

    getGherkinMatch(line: string, document: string) {
        const outlineMatch = line.match(/<.*?>/g);
        if (outlineMatch) {
            const outlineVars = this.getOutlineVars(document);
            //We should support both outlines lines variants - with and without quotes
            const pureLine = outlineMatch
                .map((s) => s.replace(/<|>/g, ''))
                .reduce((resLine, key) => {
                    if (outlineVars[key]) {
                        resLine = resLine.replace(`<${key}>`, outlineVars[key]);
                    }
                    return resLine;
                }, line);
            const quotesLine = outlineMatch
                .map((s) => s.replace(/<|>/g, ''))
                .reduce((resLine, key) => {
                    if (outlineVars[key]) {
                        resLine = resLine.replace(`<${key}>`, `"${outlineVars[key]}"`);
                    }
                    return resLine;
                }, line);
            const pureMatch = pureLine.match(this.getGherkinRegEx());
            const quotesMatch = quotesLine.match(this.getGherkinRegEx());
            if (quotesMatch && quotesMatch[4] && this.getStepByText(quotesMatch[4])) {
                return quotesMatch;
            } else {
                return pureMatch;
            }
        }
        return line.match(this.getGherkinRegEx());
    }

    handleCustomParameters(step: string): string {
        const { customParameters } = this.settings;
        if (!customParameters) {
            return step;
        }
        customParameters.forEach((p: CustomParameter) => {
            const { parameter, value } = p;
            step = step.split(parameter).join(value);
        });
        return step;
    }

    specialParameters = [
        //Ruby interpolation (like `#{Something}` ) should be replaced with `.*`
        //https://github.com/alexkrechik/VSCucumberAutoComplete/issues/65
        [/#{(.*?)}/g, '.*'],

        //Parameter-types
        //https://github.com/alexkrechik/VSCucumberAutoComplete/issues/66
        //https://docs.cucumber.io/cucumber/cucumber-expressions/
        [/{float}/g, '-?\\d*\\.?\\d+'],
        [/{int}/g, '-?\\d+'],
        [/{stringInDoubleQuotes}/g, '"[^"]+"'],
        [/{word}/g, '[^\\s]+'],
        [/{string}/g, "(\"|')[^\\1]*\\1"],
        // Note: Generic {anything} patterns are handled separately in getRegTextForStep method
    ] as const

    getRegTextForPureStep(step: string): string {
        // In pureTextSteps mode, we still support Cucumber expressions
        // but treat other regex special characters as literal text
        
        // First, change all the Cucumber expressions to regex patterns
        this.specialParameters.forEach(([parameter, change]) => {
            step = step.replace(parameter, change)
        })
    
        // Escape all special regex symbols to treat them as literal text
        step = escaprRegExpForPureText(step)

        // Restore the Cucumber expression patterns (unescape them)
        this.specialParameters.forEach(([, change]) => {
            const escapedChange = escaprRegExpForPureText(change);
            step = step.split(escapedChange).join(change)
        })

        // Compile the final regex
        return `^${step}$`;
    }

    getRegTextForStep(step: string): string {

        this.specialParameters.forEach(([parameter, change]) => {
            step = step.replace(parameter, change)
        })

        //Optional Text
        step = step.replace(/\(([a-z]+)\)/g, '($1)?');

        //Alternative text a/b/c === (a|b|c)
        step = step.replace(
            /([a-zA-Z]+)(?:\/([a-zA-Z]+))+/g,
            (match) => `(${match.replace(/\//g, '|')})`
        );

        //Handle Cucumber Expressions (like `{Something}`) should be replaced with `.*`
        //https://github.com/alexkrechik/VSCucumberAutoComplete/issues/99
        //Cucumber Expressions Custom Parameter Type Documentation
        //https://docs.cucumber.io/cucumber-expressions/#custom-parameters
        step = step.replace(/([^\\]|^){(?![\d,])(.*?)}/g, '$1.*');

        //Escape all the regex symbols to avoid errors
        step = escapeRegExp(step);

        return step;
    }

    getPartialRegParts(text: string): string[] {
    // We should separate got string into the parts by space symbol
    // But we should not touch /()/ RegEx elements
        text = this.settings.pureTextSteps
            ? this.getRegTextForPureStep(text)
            : this.getRegTextForStep(text);
        let currString = '';
        let bracesMode = false;
        let openingBracesNum = 0;
        let closingBracesNum = 0;
        const res = [];
        for (let i = 0; i <= text.length; i++) {
            const currSymbol = text[i];
            if (i === text.length) {
                res.push(currString);
            } else if (bracesMode) {
                //We should do this hard check to avoid circular braces errors
                if (currSymbol === ')') {
                    closingBracesNum++;
                    if (openingBracesNum === closingBracesNum) {
                        bracesMode = false;
                    }
                }
                if (currSymbol === '(') {
                    openingBracesNum++;
                }
                currString += currSymbol;
            } else {
                if (currSymbol === ' ') {
                    res.push(currString);
                    currString = '';
                } else if (currSymbol === '(') {
                    currString += '(';
                    bracesMode = true;
                    openingBracesNum = 1;
                    closingBracesNum = 0;
                } else {
                    currString += currSymbol;
                }
            }
        }
        return res;
    }

    getPartialRegText(regText: string): string {
    //Same with main reg, only differ is match any string that same or less that current one
        return this.getPartialRegParts(regText)
            .map((el) => `(${el}|$)`)
            .join('( |$)')
            .replace(/^\^|^/, '^');
    }

    getTextForStep(step: string): string {
        //Remove all the backslashes used for escaping regex special characters
        step = step.replace(/\\/g, '');

        //Remove "string start" and "string end" RegEx symbols
        step = step.replace(/^\^|\$$/g, '');

        // Convert regex patterns back to Cucumber expressions
        // This reverses the transformations from specialParameters
        
        // {string} pattern: (\"|')[^\\1]*\\1 becomes (\"|')[^1]*1 after removing backslashes  
        // Use exact string replacement since regex escaping is complex for this pattern
        step = step.split('(\"|\')\[^1]*1').join('{string}');
        
        // {stringInDoubleQuotes} pattern: "[^"]+"
        step = step.replace(/"\[^"\]\+"/g, '{stringInDoubleQuotes}');
        
        // {word} pattern: [^\s]+ becomes [^s]+ after removing backslashes
        step = step.replace(/\[^s\]\+/g, '{word}');
        
        // {int} pattern: -?\d+ becomes -?d+ after removing backslashes
        step = step.replace(/-\?d\+/g, '{int}');
        
        // {float} pattern: -?\d*\.?\d+ becomes -?d*.?d+ after removing backslashes
        step = step.replace(/-\?d\*\.\?d\+/g, '{float}');
        
        // Note: Generic {anything} patterns that were converted to .* by the regex 
        // step.replace(/([^\\]|^){(?![\d,])(.*?)}/g, '$1.*') are not restored here
        // because we cannot reliably determine the original parameter name
        
        return step;
    }

    // New method to get text for step that preserves Cucumber expressions
    getTextForStepWithCucumberExpressions(originalStep: string): string {
        // For non-pureTextSteps mode, we want to preserve the original Cucumber expressions
        // instead of converting them to regex and back
        let step = originalStep;
        
        // Remove backslashes used for escaping in regex
        step = step.replace(/\\\(/g, '(').replace(/\\\)/g, ')');
        step = step.replace(/\\\[/g, '[').replace(/\\\]/g, ']');
        step = step.replace(/\\\{/g, '{').replace(/\\\}/g, '}');
        step = step.replace(/\\\./g, '.');
        step = step.replace(/\\\*/g, '*');
        step = step.replace(/\\\+/g, '+');
        step = step.replace(/\\\?/g, '?');
        step = step.replace(/\\\|/g, '|');
        step = step.replace(/\\\^/g, '^');
        step = step.replace(/\\\$/g, '$');
        
        // Remove regex anchors
        step = step.replace(/^\^/, '').replace(/\$$/, '');
        
        return step;
    }

    getDescForStep(step: string): string {
    //Remove 'Function body' part
        step = step.replace(/\{.*/, '');

        //Remove spaces in the beginning end in the end of string
        step = step.replace(/^\s*/, '').replace(/\s*$/, '');

        return step;
    }

    getStepTextInvariants(step: string): string[] {
    //Handle regexp's like 'I do (one|to|three)'
    //TODO - generate correct num of invariants for the circular braces
        const bracesRegEx = /(\([^)()]+\|[^()]+\))/;
        if (~step.search(bracesRegEx)) {
            const match = step.match(bracesRegEx);
            const matchRes = match![1];
            const variants = matchRes
                .replace(/\(\?:/, '')
                .replace(/^\(|\)$/g, '')
                .split('|');
            return variants.reduce((varRes, variant) => {
                return varRes.concat(
                    this.getStepTextInvariants(step.replace(matchRes, variant))
                );
            }, new Array<string>());
        } else {
            return [step];
        }
    }

    getCompletionInsertText(step: string, stepPart: string): string {
        // In pureTextSteps mode, return the original step text directly
        if (this.settings.pureTextSteps) {
            // Simple partial matching for pureTextSteps mode
            if (step.toLowerCase().startsWith(stepPart.toLowerCase())) {
                // Return the part that comes after the stepPart
                return step.substring(stepPart.length).trim();
            }
            return step;
        }

        // Store original step for parameter recovery before any processing
        const originalStep = step;

        // Return only part we need for our step
        let res = step;
        
        // We need to use a different approach since getPartialRegParts modifies the content
        // Let's work with the original step and do partial matching manually
        const originalStepParts = originalStep.split(' ');
        const stepPartWords = stepPart.trim().split(' ');
        
        // Find how many words from the beginning match
        let matchingWordsCount = 0;
        for (let i = 0; i < Math.min(originalStepParts.length, stepPartWords.length); i++) {
            // For Cucumber expressions, we need special handling
            const originalWord = originalStepParts[i];
            const stepWord = stepPartWords[i];
            
            if (originalWord.startsWith('{') && originalWord.endsWith('}')) {
                // This is a Cucumber expression, it should match any word in stepPart
                matchingWordsCount++;
            } else if (originalWord.toLowerCase() === stepWord.toLowerCase()) {
                // Exact match (case insensitive)
                matchingWordsCount++;
            } else {
                // Check if it's a partial match for the last word
                if (i === stepPartWords.length - 1 && originalWord.toLowerCase().startsWith(stepWord.toLowerCase())) {
                    matchingWordsCount++;
                }
                break;
            }
        }
        
        // Return the remaining part of the step
        const remainingParts = originalStepParts.slice(matchingWordsCount);
        res = remainingParts.join(' ');

        if (this.settings.smartSnippets) {
            /*
                Convert parameter placeholders to VS Code snippets
                Look for Cucumber expressions like {word}, {string}, {int}, etc.
                and convert them to ${1:}, ${2:}, etc.
            */
            const parameterMatches = res.match(/\{[^}]+\}/g);
            if (parameterMatches) {
                parameterMatches.forEach((param, index) => {
                    const snippetNumber = index + 1;
                    res = res.replace(param, `\${${snippetNumber}:}`);
                });
            } else {
                // If no Cucumber expressions found, look for .* patterns (fallback for processed steps)
                const dotStarMatches = res.match(/\.\*/g);
                if (dotStarMatches) {
                    dotStarMatches.forEach((match, index) => {
                        const snippetNumber = index + 1;
                        res = res.replace(match, `\${${snippetNumber}:}`);
                    });
                }
            }
        } else {
            // For non-smartSnippets mode, clean up common patterns
            res = res.replace(/"\[\^"\]\+"/g, '""');
            // Clean up .* patterns that represent parameters
            res = res.replace(/\.\*/g, '{}');
        }

        return res;
    }



    getDocumentation(stepRawComment: string) {
        const stepParsedComment = commentParser.parse(stepRawComment.trim(), {
            unwrap: true,
            sloppy: true,
            recoverable: true,
        });
        return (
            stepParsedComment.description ||
      (stepParsedComment.tags.find((tag) => tag.title === 'description') || {})
          .description ||
      (stepParsedComment.tags.find((tag) => tag.title === 'desc') || {})
          .description ||
      stepRawComment
        );
    }

    getSteps(
        fullStepLine: string,
        stepPart: string,
        def: Location,
        gherkin: GherkinType,
        comments: JSDocComments
    ): Step[] {
        const stepsVariants = this.settings.stepsInvariants
            ? this.getStepTextInvariants(stepPart)
            : [stepPart];
        const desc = this.getDescForStep(fullStepLine);
        const comment = comments[def.range.start.line];
        const documentation = comment
            ? this.getDocumentation(comment)
            : fullStepLine;
        return stepsVariants
            .filter((step) => {
                //Filter invalid long regular expressions
                try {
                    const regText = this.settings.pureTextSteps
                        ? this.getRegTextForPureStep(step)
                        : this.getRegTextForStep(step);
                    new RegExp(regText);
                    return true;
                } catch (err) {
                    //Todo - show some warning
                    return false;
                }
            })
            .map((step) => {
                const regText = this.settings.pureTextSteps
                    ? this.getRegTextForPureStep(step)
                    : this.getRegTextForStep(step);
                const reg = new RegExp(regText);
                let partialReg;
                // Use long regular expression in case of error
                try {
                    partialReg = new RegExp(this.getPartialRegText(step));
                } catch (err) {
                    // Todo - show some warning
                    partialReg = reg;
                }
                //Todo we should store full value here
                const text = this.settings.pureTextSteps
                    ? step
                    : this.getTextForStep(step);
                const id = 'step' + getMD5Id(text);
                const count = this.getElementCount(id);
                return {
                    id,
                    reg,
                    partialReg,
                    text,
                    desc,
                    def,
                    count,
                    gherkin,
                    documentation,
                };
            });
    }

    getMultiLineComments(content: string) {
        return content.split(/\r?\n/g).reduce(
            (res, line, i) => {
                if (~line.search(/^\s*\/\*/)) {
                    res.current = `${line}\n`;
                    res.commentMode = true;
                } else if (~line.search(/^\s*\*\//)) {
                    res.current += `${line}\n`;
                    res.comments[i + 1] = res.current;
                    res.commentMode = false;
                } else if (res.commentMode) {
                    res.current += `${line}\n`;
                }
                return res;
            },
            {
                comments: {} as JSDocComments,
                current: '',
                commentMode: false,
            }
        ).comments;
    }

    getFileSteps(filePath: string) {
        const fileContent = getFileContent(filePath);
        const fileComments = this.getMultiLineComments(fileContent);
        const definitionFile = clearComments(fileContent);
        return definitionFile
            .split(/\r?\n/g)
            .reduce((steps, line, lineIndex, lines) => {
                //TODO optimize
                let match;
                let finalLine = '';
                const currLine = this.handleCustomParameters(line);
                const currentMatch = this.geStepDefinitionMatch(currLine);
                //Add next line to our string to handle two-lines step definitions
                const nextLine = this.handleCustomParameters(lines[lineIndex + 1] || '');
                if (currentMatch) {
                    match = currentMatch;
                    finalLine = currLine;
                } else if (nextLine) {
                    const nextLineMatch = this.geStepDefinitionMatch(nextLine);
                    const bothLinesMatch = this.geStepDefinitionMatch(
                        currLine + nextLine
                    );
                    if (bothLinesMatch && !nextLineMatch) {
                        match = bothLinesMatch;
                        finalLine = currLine + nextLine;
                    }
                }
                if (match) {
                    // 安全检查：确保 match 数组有足够的元素且不为 undefined
                    if (match.length >= 5 && match[1] !== undefined && match[2] !== undefined && match[4] !== undefined) {
                        const [, beforeGherkin, gherkinString, , stepPart] = match;
                        const gherkin = getGherkinTypeLower(gherkinString);
                        const pos = Position.create(lineIndex, beforeGherkin.length);
                        const def = Location.create(
                            getOSPath(filePath),
                            Range.create(pos, pos)
                        );
                        steps = steps.concat(
                            this.getSteps(finalLine, stepPart, def, gherkin, fileComments)
                        );
                    }
                }
                return steps;
            }, new Array<Step>());
    }

    validateConfiguration(
        settingsFile: string,
        stepsPathes: StepSettings,
        workSpaceRoot: string
    ) {
        return stepsPathes.reduce((res, path) => {
            const files = glob.sync(path);
            if (!files.length) {
                const searchTerm = path.replace(workSpaceRoot + '/', '');
                const range = getTextRange(
                    workSpaceRoot + '/' + settingsFile,
                    `"${searchTerm}"`
                );
                res.push({
                    severity: DiagnosticSeverity.Warning,
                    range: range,
                    message: 'No steps files found',
                    source: 'cucumberautocomplete',
                });
            }
            return res;
        }, new Array<Diagnostic>());
    }

    populate(root: string, stepsPathes: StepSettings): void {
        this.elementsHash = {};
        this.elements = stepsPathes
            .reduce(
                (files, path) =>
                    files.concat(glob.sync(root + '/' + path, { absolute: true })),
                new Array<string>()
            )
            .reduce(
                (elements, f) =>
                    elements.concat(
                        this.getFileSteps(f).reduce((steps, step) => {
                            if (!this.elementsHash[step.id]) {
                                steps.push(step);
                                this.elementsHash[step.id] = true;
                            }
                            return steps;
                        }, new Array<Step>())
                    ),
                new Array<Step>()
            );
    }

    getStepByText(text: string, gherkin?: GherkinType) {
        return this.elements.find(
            (s) => {
                const isGherkinOk = gherkin !== undefined ? s.gherkin === gherkin : true;
                const isStepOk = s.reg.test(text);
                return isGherkinOk && isStepOk;
            }
        );
    }

    validate(line: string, lineNum: number, text: string) {
        line = line.replace(/\s*$/, '');
        const lineForError = line.replace(/^\s*/, '');
        const match = this.getGherkinMatch(line, text);
        if (!match) {
            return null;
        }
        const beforeGherkin = match[1];
        const gherkinPart = match[2];
        const gherkinWord = this.settings.strictGherkinValidation
            ? this.getStrictGherkinType(gherkinPart, lineNum, text)
            : undefined;
        const step = this.getStepByText(match[4], gherkinWord);
        if (step) {
            return null;
        } else {
            return {
                severity: DiagnosticSeverity.Warning,
                range: {
                    start: { line: lineNum, character: beforeGherkin.length },
                    end: { line: lineNum, character: line.length },
                },
                message: `Was unable to find step for "${lineForError}"`,
                source: 'cucumberautocomplete',
            } as Diagnostic;
        }
    }

    getDefinition(line: string, text: string): Definition | null {
        const match = this.getGherkinMatch(line, text);
        if (!match) {
            return null;
        }
        const step = this.getStepByText(match[4]);
        return step ? step.def : null;
    }

    getStrictGherkinType(gherkinPart: string, lineNumber: number, text: string) {
        const gherkinType = getGherkinType(gherkinPart);
        if (gherkinType === GherkinType.And || gherkinType === GherkinType.But) {
            return text
                .split(/\r?\n/g)
                .slice(0, lineNumber)
                .reduceRight((res, val) => {
                    if (res === GherkinType.Other) {
                        const match = this.getGherkinMatch(val, text);
                        if (match) {
                            const [, , prevGherkinPart] = match;
                            const prevGherkinPartType = getGherkinTypeLower(prevGherkinPart);
                            if (
                                ~[
                                    GherkinType.Given,
                                    GherkinType.When,
                                    GherkinType.Then,
                                ].indexOf(prevGherkinPartType)
                            ) {
                                res = prevGherkinPartType;
                            }
                        }
                    }
                    return res;
                }, GherkinType.Other);
        } else {
            return getGherkinTypeLower(gherkinPart);
        }
    }

    getCompletion(
        line: string,
        lineNumber: number,
        text: string
    ): CompletionItem[] | null {
    //Get line part without gherkin part
        const match = this.getGherkinMatch(line, text);
        if (!match) {
            return null;
        }
        const [, , gherkinPart, , stepPartBase] = match;
        //We don't need last word in our step part due to it could be incompleted
        let stepPart = stepPartBase || '';
        stepPart = stepPart.replace(/[^\s]+$/, '');
        const res = this.elements
        //Filter via gherkin words comparing if strictGherkinCompletion option provided
            .filter((step) => {
                if (this.settings.strictGherkinCompletion) {
                    const strictGherkinPart = this.getStrictGherkinType(
                        gherkinPart,
                        lineNumber,
                        text
                    );
                    return step.gherkin === strictGherkinPart;
                } else {
                    return true;
                }
            })
        //Current string without last word should partially match our regexp
            .filter((step) => step.partialReg.test(stepPart))
        //We got all the steps we need so we could make completions from them
            .map((step) => {
                return {
                    label: step.text,
                    kind: CompletionItemKind.Snippet,
                    data: step.id,
                    documentation: step.documentation,
                    sortText: getSortPrefix(step.count, 5) + '_' + step.text,
                    insertText: this.getCompletionInsertText(step.text, stepPart),
                    insertTextFormat: InsertTextFormat.Snippet,
                };
            });
        return res.length ? res : null;
    }

    getCompletionResolve(item: CompletionItem): CompletionItem {
        this.incrementElementCount(item.data);
        return item;
    }
}
