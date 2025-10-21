import * as path from 'path';
import * as fs from 'fs';
import * as glob from 'glob';
import * as https from 'https';
import * as http from 'http';
import * as url from 'url';

import { workspace, ExtensionContext, commands, window, ProgressLocation, ConfigurationTarget } from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient;

/**
 * 扫描步骤文件并使用 AI 逐个生成对应的 JSON 文件
 */
async function scanAndGenerateStepsJson(workspaceRoot: string): Promise<{ totalSteps: number; generatedFiles: string[] }> {
    const config = workspace.getConfiguration('cucumberautocomplete');
    // 使用 steps 配置来扫描步骤定义文件
    const stepsPaths = config.get<string[]>('steps') || [];
    const aiConfig = config.get<any>('aiConfig') || {};
    
    if (!aiConfig.token) {
        throw new Error('AI token is required. Please configure cucumberautocomplete.aiConfig.token in settings.');
    }
    
    if (stepsPaths.length === 0) {
        throw new Error('No steps paths configured for scanning. Please configure cucumberautocomplete.steps in settings.');
    }
    
    // 扫描 cucumberautocomplete.steps 配置中的所有步骤文件
    const allStepFiles: string[] = [];
    
    for (const stepPath of stepsPaths) {
        const fullPath = path.join(workspaceRoot, stepPath);
        const files = glob.sync(fullPath, { absolute: true });
        allStepFiles.push(...files);
    }
    
    if (allStepFiles.length === 0) {
        throw new Error('No step definition files found. Please check your cucumberautocomplete.steps configuration paths.');
    }
    
    window.showInformationMessage(`Found ${allStepFiles.length} step definition files. Analyzing with AI...`);
    
    const generatedFiles: string[] = [];
    let totalSteps = 0;
    
    // 为每个文件单独调用 AI API 生成对应的 JSON 文件
    for (let i = 0; i < allStepFiles.length; i++) {
        const filePath = allStepFiles[i];
        try {
            // 检查文件大小，跳过过大的文件（如 node_modules 中的文件）
            const stats = fs.statSync(filePath);
            const fileSizeMB = stats.size / (1024 * 1024);
            
            if (fileSizeMB > 2) { // 跳过大于1MB的文件
                console.warn(`Skipping large file (${fileSizeMB.toFixed(2)}MB): ${filePath}`);
                window.showWarningMessage(`Skipping large file: ${path.basename(filePath)} (${fileSizeMB.toFixed(2)}MB)`);
                continue;
            }
            

            const content = fs.readFileSync(filePath, 'utf8');
            
            // 检查内容是否为空或过短
            if (!content.trim() || content.trim().length < 10) {
                console.warn(`Skipping empty or too short file: ${filePath}`);
                continue;
            }
            
            console.log(`Processing file ${i + 1}/${allStepFiles.length}: ${path.basename(filePath)}`);
            
            // 调用 AI API 分析单个步骤定义文件
            const stepsArray = await callAIForSingleFileExtraction(filePath, content, aiConfig);
            
            if (stepsArray && stepsArray.length > 0) {
                // 生成对应的 JSON 文件名
                const jsonFilePath = generateJsonFileName(filePath, workspaceRoot);
                
                // 确保目录存在
                const dir = path.dirname(jsonFilePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                
                // 写入 JSON 文件
                const jsonContent = JSON.stringify(stepsArray, null, 2);
                fs.writeFileSync(jsonFilePath, jsonContent, 'utf8');
                
                generatedFiles.push(jsonFilePath);
                totalSteps += stepsArray.length;
                
                console.log(`Generated ${jsonFilePath} with ${stepsArray.length} steps`);
            }
        } catch (error) {
            console.warn(`Failed to process file ${filePath}:`, error);
            window.showWarningMessage(`Failed to process ${path.basename(filePath)}: ${error}`);
        }
    }
    
    return { totalSteps, generatedFiles };
}

/**
 * 生成 JSON 文件名：将源文件扩展名替换为 .steps.json，并放在 .vscode/stepConfig 目录下
 */
function generateJsonFileName(sourceFilePath: string, workspaceRoot: string): string {
    const relativePath = path.relative(workspaceRoot, sourceFilePath);
    const parsedPath = path.parse(relativePath);
    
    // 生成 JSON 文件名，避免重复的 .steps 后缀
    let baseName = parsedPath.name;
    if (baseName.endsWith('.steps')) {
        baseName = baseName.slice(0, -6); // 移除已存在的 .steps 后缀
    }
    const jsonFileName = `${baseName}.steps.json`;
    
    // 将生成的 JSON 文件放在 .vscode/stepConfig 目录下
    const stepConfigDir = path.join(workspaceRoot, '.vscode', 'stepConfig');
    const jsonFilePath = path.join(stepConfigDir, jsonFileName);
    
    return jsonFilePath;
}

/**
 * 调用 AI API 提取单个文件的步骤定义
 */
async function callAIForSingleFileExtraction(filePath: string, fileContent: string, aiConfig: any): Promise<any[]> {
    const prompt = aiConfig.prompt || '请提取文件中的Step定义并转换为Step[]数组。';
    const model = aiConfig.model || 'gpt-4o-mini';
    
    // 构建请求内容
    const requestBody = {
        model: model,
        messages: [
            {
                role: 'system',
                content: `${prompt}

请分析提供的步骤定义文件，提取出所有的步骤定义，并返回一个Step 的JSON数组：

export type Step = {
  id: string;               // 唯一 ID，可以用步骤名的哈希或 slug
  reg: RegExp;              // 用于匹配完整语句的正则
  partialReg: RegExp;       // 用于匹配语句开头的正则
  text: string;             // 该步骤的简短文本描述
  desc: string;             // 对该步骤更详细的描述
  def: Definition;          // 对应 Definition，可以模拟或生成一个占位符
  count: number;            // 出现次数（如未提供则默认 0）
  gherkin: GherkinType;     // Gherkin 步骤类型 记得转换为数值，后续提供了枚举定义
  documentation: string;    // 文档说明，可从文本中提取，也可生成简短解释
  regText: string;         // 用于匹配完整语句的正则文本
  matchText: string;       // 用于匹配文本，将步骤文本转换为匹配文本，Cucumber表达式也要转换为正则表达式匹配
};
对于regText字段，请将步骤文本转换为正则表达式字符串，保留Cucumber表达式如{string}, {int}等，并对特殊字符进行转义,对于括号的内容均处理为可选参数。
对于matchText字段，用于匹配输入的文本，将步骤文本转换为匹配文本，Cucumber表达式也要转换为正则表达式匹配
regText和matchText通用要求:对于文本中的(s)等量词形式的， 处理为可选的复数形式,例如: "runs" 应该匹配 "run" 和 "runs", 生成的正则可以是 "runs?"。
其他需要使用到的类型：
export enum GherkinType {
    Given,
    When,
    Then,
    And,
    But,
    Other
}

**规则：**
1. 识别文本中的每个步骤（Step）。
2. 为每个步骤生成一个对象。
3. 如果某些字段文本里没有提供，请合理填充占位符（如 desc: "待补充"，documentation: "待补充"）。
4. 输出结果必须是 Step[] 数组。

请只返回JSON数组，不要包含其他解释文字。如果文件中没有找到步骤定义，请返回空数组[]。`
            },
            {
                role: 'user',
                content: `File: ${filePath}\n\n${fileContent}`
            }
        ]
    };
    
    return new Promise((resolve, reject) => {
        const apiUrl = 'https://api.openai.com/v1/chat/completions';
        const parsedUrl = url.parse(aiConfig.proxy || apiUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const requestModule = isHttps ? https : http;
        
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${aiConfig.token}`,
                'Content-Length': Buffer.byteLength(JSON.stringify(requestBody))
            }
        };
        
        const req = requestModule.request(options, (res: any) => {
            let data = '';
            res.on('data', (chunk: any) => data += chunk);
            res.on('end', () => {
                try {
                    console.log(`[${path.basename(filePath)}] AI API response status: ${res.statusCode}`);
                    
                    if (res.statusCode !== 200) {
                        console.error(`[${path.basename(filePath)}] AI API error response:`, data);
                        reject(new Error(`AI API returned status ${res.statusCode}: ${data}`));
                        return;
                    }
                    
                    const response = JSON.parse(data);
                    
                    // 检查是否有错误信息
                    if (response.error) {
                        console.error(`[${path.basename(filePath)}] AI API error:`, response.error);
                        reject(new Error(`AI API error: ${response.error.message || JSON.stringify(response.error)}`));
                        return;
                    }
                    
                    // 检查响应格式
                    if (!response.choices || !response.choices[0] || !response.choices[0].message) {
                        console.error(`[${path.basename(filePath)}] Invalid AI response structure:`, response);
                        reject(new Error(`Invalid AI response structure. Expected choices[0].message, got: ${JSON.stringify(response)}`));
                        return;
                    }
                    
                    const content = response.choices[0].message.content;
                    console.log(`[${path.basename(filePath)}] AI response content preview: ${content.substring(0, 100)}...`);
                    
                    if (!content || content.trim() === '') {
                        console.warn(`[${path.basename(filePath)}] AI returned empty content`);
                        resolve([]); // Return empty array instead of rejecting
                        return;
                    }
                    
                    // 尝试解析 JSON 内容
                    try {
                        // 清理可能的 markdown 代码块标记和其他非JSON内容
                        let cleanContent = content.replace(/```json\s*|\s*```/g, '').trim();
                        
                        // 尝试提取JSON数组部分
                        const arrayMatch = cleanContent.match(/\[[\s\S]*\]/);
                        if (arrayMatch) {
                            cleanContent = arrayMatch[0];
                        }
                        
                        const stepsArray = JSON.parse(cleanContent);
                        
                        // 验证返回的是数组
                        if (!Array.isArray(stepsArray)) {
                            console.warn(`[${path.basename(filePath)}] AI returned non-array data:`, typeof stepsArray);
                            resolve([]); // Return empty array instead of rejecting
                            return;
                        }
                        
                        console.log(`[${path.basename(filePath)}] Successfully parsed ${stepsArray.length} steps from AI response`);
                        resolve(stepsArray);
                        
                    } catch (parseError) {
                        console.error(`[${path.basename(filePath)}] Failed to parse AI response as JSON:`, parseError);
                        console.error(`[${path.basename(filePath)}] Raw content:`, content);
                        
                        // 尝试从响应中提取可能的错误信息
                        if (content.toLowerCase().includes('error') || content.toLowerCase().includes('sorry')) {
                            reject(new Error(`AI processing error: ${content.substring(0, 200)}...`));
                        } else {
                            // 返回空数组而不是拒绝，让其他文件继续处理
                            console.warn(`[${path.basename(filePath)}] Returning empty array due to parse error`);
                            resolve([]);
                        }
                        return;
                    }
                    
                } catch (error) {
                    console.error(`[${path.basename(filePath)}] Failed to process AI response:`, error);
                    console.error(`[${path.basename(filePath)}] Raw data:`, data.substring(0, 500));
                    reject(new Error(`Failed to process AI response: ${error}`));
                }
            });
        });
        
        req.on('error', (error: any) => {
            console.error(`[${path.basename(filePath)}] AI API request failed:`, error);
            reject(new Error(`AI API request failed: ${error}`));
        });
        
        req.write(JSON.stringify(requestBody));
        req.end();
    });
}

/**
 * 调用 AI API 提取步骤定义（兼容旧版本）
 */
async function callAIForStepExtraction(fileContents: { filePath: string; content: string }[], aiConfig: any): Promise<any[]> {
    const prompt = aiConfig.prompt || '请提取文件中的Step定义并转换为Step[]数组。';
    const model = aiConfig.model || 'gpt-4o-mini';
    
    // 构建请求内容
    const filesContent = fileContents.map(f => `File: ${f.filePath}\n\n${f.content}`).join('\n\n---\n\n');
    
    const requestBody = {
        model: model,
        messages: [
            {
                role: 'system',
                content: `${prompt}

请分析提供的步骤定义文件，提取出所有的步骤定义，并返回一个JSON数组。每个步骤对象应包含以下字段：
- id: 唯一标识符
- text: 步骤文本（保留Cucumber表达式如{string}, {int}等）
- regText: 正则表达式文本（用于匹配）
- partialRegText: 部分匹配的正则表达式
- desc: 描述
- gherkin: Gherkin关键字（given/when/then/and/but）
- documentation: 文档说明
- count: 使用次数（默认0）
- def: 定义位置信息

请只返回JSON数组，不要包含其他解释文字。`
            },
            {
                role: 'user',
                content: filesContent
            }
        ],
        temperature: 0.1,
        max_tokens: 400000
    };
    
    return new Promise((resolve, reject) => {
        const apiUrl = 'https://api.openai.com/v1/chat/completions';
        const parsedUrl = url.parse(aiConfig.proxy || apiUrl);
        const isHttps = parsedUrl.protocol === 'https:';
        const requestModule = isHttps ? https : http;
        
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${aiConfig.token}`,
                'Content-Length': Buffer.byteLength(JSON.stringify(requestBody))
            }
        };
        
        const req = requestModule.request(options, (res: any) => {
            let data = '';
            res.on('data', (chunk: any) => data += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response.choices && response.choices[0] && response.choices[0].message) {
                        const content = response.choices[0].message.content;
                        const stepsArray = JSON.parse(content);
                        resolve(stepsArray);
                    } else {
                        reject(new Error('Invalid AI response format'));
                    }
                } catch (error) {
                    reject(new Error(`Failed to parse AI response: ${error}`));
                }
            });
        });
        
        req.on('error', (error: any) => {
            reject(new Error(`AI API request failed: ${error}`));
        });
        
        req.write(JSON.stringify(requestBody));
        req.end();
    });
}

/**
 * 更新 VS Code 编辑器设置中的 acceptSuggestionOnEnter 配置
 */
async function updateEditorConfiguration(enableNewlineMode: boolean) {
    try {
        const config = workspace.getConfiguration();
        
        // 为 .feature 文件设置特定的编辑器行为
        // enableNewlineMode = true: Enter键总是换行
        // enableNewlineMode = false: 使用VS Code默认行为
        const acceptSuggestionOnEnter = enableNewlineMode ? 'off' : 'on';
        
        // 更新工作区配置，只影响 .feature 文件
        await config.update('[feature]', {
            'editor.acceptSuggestionOnEnter': acceptSuggestionOnEnter
        }, ConfigurationTarget.Workspace);
        
        console.log(`Updated [feature] editor.acceptSuggestionOnEnter to: ${acceptSuggestionOnEnter}`);
    } catch (error) {
        console.error('Error updating editor configuration:', error);
    }
}

/**
 * 监听配置更改
 */
function setupConfigurationWatcher(context: ExtensionContext) {
    // 初始化时应用当前配置
    const config = workspace.getConfiguration('cucumberautocomplete');
    const enableNewlineMode = config.get<boolean>('enableEnterKeyNewlineMode', true);
    updateEditorConfiguration(enableNewlineMode);
    
    // 监听配置更改
    const configWatcher = workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('cucumberautocomplete.enableEnterKeyNewlineMode')) {
            const config = workspace.getConfiguration('cucumberautocomplete');
            const enableNewlineMode = config.get<boolean>('enableEnterKeyNewlineMode', true);
            updateEditorConfiguration(enableNewlineMode);
            
            window.showInformationMessage(
                'Editor configuration updated for .feature files. Changes take effect immediately.',
                'Got it'
            );
        }
    });
    
    context.subscriptions.push(configWatcher);
}
function registerCommands(context: ExtensionContext) {
    // 注册扫描步骤文件并生成 steps.json 的命令
    const initStepsCommand = commands.registerCommand('cucumberautocomplete.steps.init', async () => {
        try {
            const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                window.showErrorMessage('No workspace folder found. Please open a workspace first.');
                return;
            }

            // 询问用户是否要继续，因为可能会生成多个文件
            const proceed = await window.showInformationMessage(
                'This will scan your step definition files and generate corresponding JSON files using AI. Continue?',
                'Yes', 'No'
            );
            if (proceed !== 'Yes') {
                return;
            }
            
            // 显示进度指示器
            await window.withProgress({
                location: ProgressLocation.Notification,
                title: 'Generating steps.json with AI',
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 0, message: 'Scanning step files...' });
                
                // 扫描文件并使用 AI 生成步骤定义
                const result = await scanAndGenerateStepsJson(workspaceRoot);
                
                progress.report({ increment: 100, message: 'Complete!' });
                
                if (result.generatedFiles.length > 0) {
                    window.showInformationMessage(
                        `Successfully generated ${result.generatedFiles.length} JSON files with ${result.totalSteps} total steps`
                    );
                    
                    // 更新配置以包含所有生成的 JSON 文件
                    const config = workspace.getConfiguration('cucumberautocomplete');
                    await config.update('stepsJsonFiles', result.generatedFiles.map(file => 
                        path.relative(workspaceRoot, file).replace(/\\/g, '/')
                    ), ConfigurationTarget.Workspace);
                    
                    window.showInformationMessage(
                        'Configuration updated! The generated JSON files have been added to stepsJsonFiles setting.'
                    );
                    
                    // 可选：打开第一个生成的文件
                    if (result.generatedFiles.length > 0) {
                        const openFile = await window.showInformationMessage(
                            'Would you like to open one of the generated JSON files?',
                            'Yes', 'No'
                        );
                        if (openFile === 'Yes') {
                            const document = await workspace.openTextDocument(result.generatedFiles[0]);
                            await window.showTextDocument(document);
                        }
                    }
                } else {
                    window.showWarningMessage('No JSON files were generated. Please check your step definition files and AI configuration.');
                }
            });
            
        } catch (error) {
            window.showErrorMessage(`Failed to generate steps.json: ${error}`);
        }
    });

    context.subscriptions.push(initStepsCommand);
}

export function activate(context: ExtensionContext) {
    // Node server module
    const serverModule = context.asAbsolutePath(
        path.join('gserver', 'out', 'server.js')
    );

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
        },
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
    // Register the server for Cucumber feature files
        documentSelector: [{ scheme: 'file', language: 'feature' }],
        synchronize: {
            // Notify the server about file changes to '.clientrc files contain in the workspace
            fileEvents: workspace.createFileSystemWatcher('**/.clientrc'),
        },
    };

    // Create the language client and start the client.
    client = new LanguageClient(
        'cucumberautocomplete-client',
        'Cucumber auto complete plugin',
        serverOptions,
        clientOptions
    );

    // Register commands
    registerCommands(context);

    // Setup configuration watcher for acceptSuggestionOnEnter
    setupConfigurationWatcher(context);

    // Start the client. This will also launch the server
    client.start();
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
