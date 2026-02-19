/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { IJSONSchema, IJSONSchemaMap } from '../../../../../../base/common/jsonSchema.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { ChatContextKeys } from '../../actions/chatContextKeys.js';
import { CountTokensCallback, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolInvocationPreparationContext, IToolResult, ToolDataSource, ToolInvocationPresentation, ToolProgress } from '../languageModelToolsService.js';
import { createToolSimpleTextResult } from './toolHelpers.js';
import { IBreakpoint, IBreakpointData, IDebugService, IDebugSession, IScope, IStackFrame, IThread, getStateLabel } from '../../../../debug/common/debug.js';

export const DebugReadToolId = 'vscode_debug_read';
export const DebugControlToolId = 'vscode_debug_control';

const enum DebugReadAction {
	ListSessions = 'listSessions',
	ListThreads = 'listThreads',
	ListStackFrames = 'listStackFrames',
	ListScopes = 'listScopes',
	ListVariables = 'listVariables',
	Evaluate = 'evaluate',
	ListBreakpoints = 'listBreakpoints',
}

const enum DebugControlAction {
	AddBreakpoint = 'addBreakpoint',
	RemoveBreakpoint = 'removeBreakpoint',
	SetBreakpointsActivated = 'setBreakpointsActivated',
	Continue = 'continue',
	Pause = 'pause',
	StepOver = 'stepOver',
	StepInto = 'stepInto',
	StepOut = 'stepOut',
	Restart = 'restart',
	Stop = 'stop',
	Terminate = 'terminate',
}

interface IDebugReadToolParams {
	action: DebugReadAction;
	sessionId?: string;
	sessionName?: string;
	threadId?: number;
	frameId?: number;
	scopeIndex?: number;
	scopeName?: string;
	expression?: string;
	includeInactive?: boolean;
}

interface IDebugControlToolParams {
	action: DebugControlAction;
	sessionId?: string;
	sessionName?: string;
	threadId?: number;
	frameId?: number;
	uri?: string;
	lineNumber?: number;
	column?: number;
	condition?: string;
	hitCondition?: string;
	logMessage?: string;
	enabled?: boolean;
	breakpointId?: string;
	breakpointsActivated?: boolean;
}

const DebugReadInputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
	type: 'object',
	properties: {
		action: {
			type: 'string',
			enum: [
				DebugReadAction.ListSessions,
				DebugReadAction.ListThreads,
				DebugReadAction.ListStackFrames,
				DebugReadAction.ListScopes,
				DebugReadAction.ListVariables,
				DebugReadAction.Evaluate,
				DebugReadAction.ListBreakpoints,
			],
			description: 'The debug read action to perform.'
		},
		sessionId: {
			type: 'string',
			description: 'Session id to target. If omitted, uses the focused session.'
		},
		sessionName: {
			type: 'string',
			description: 'Session name to target. Used when sessionId is not provided.'
		},
		threadId: {
			type: 'number',
			description: 'Thread id to target for stack queries.'
		},
		frameId: {
			type: 'number',
			description: 'Stack frame id to target for scopes or evaluations.'
		},
		scopeIndex: {
			type: 'number',
			description: 'Scope index from listScopes to list variables.'
		},
		scopeName: {
			type: 'string',
			description: 'Scope name to list variables from when scopeIndex is not provided.'
		},
		expression: {
			type: 'string',
			description: 'Expression to evaluate in the selected stack frame.'
		},
		includeInactive: {
			type: 'boolean',
			description: 'Include inactive sessions when listing sessions.'
		}
	},
	required: ['action'],
	additionalProperties: false
};

const DebugControlInputSchema: IJSONSchema & { properties: IJSONSchemaMap } = {
	type: 'object',
	properties: {
		action: {
			type: 'string',
			enum: [
				DebugControlAction.AddBreakpoint,
				DebugControlAction.RemoveBreakpoint,
				DebugControlAction.SetBreakpointsActivated,
				DebugControlAction.Continue,
				DebugControlAction.Pause,
				DebugControlAction.StepOver,
				DebugControlAction.StepInto,
				DebugControlAction.StepOut,
				DebugControlAction.Restart,
				DebugControlAction.Stop,
				DebugControlAction.Terminate,
			],
			description: 'The debug control action to perform.'
		},
		sessionId: {
			type: 'string',
			description: 'Session id to target. If omitted, uses the focused session.'
		},
		sessionName: {
			type: 'string',
			description: 'Session name to target. Used when sessionId is not provided.'
		},
		threadId: {
			type: 'number',
			description: 'Thread id to target for stepping.'
		},
		frameId: {
			type: 'number',
			description: 'Stack frame id to target for certain operations.'
		},
		uri: {
			type: 'string',
			description: 'Absolute file path or URI for breakpoint actions.'
		},
		lineNumber: {
			type: 'number',
			description: '1-based line number for breakpoint actions.'
		},
		column: {
			type: 'number',
			description: '1-based column number for breakpoint actions.'
		},
		condition: {
			type: 'string',
			description: 'Conditional expression for breakpoints.'
		},
		hitCondition: {
			type: 'string',
			description: 'Hit condition for breakpoints.'
		},
		logMessage: {
			type: 'string',
			description: 'Log message for logpoints.'
		},
		enabled: {
			type: 'boolean',
			description: 'Whether the breakpoint should be enabled when added.'
		},
		breakpointId: {
			type: 'string',
			description: 'Breakpoint id to remove.'
		},
		breakpointsActivated: {
			type: 'boolean',
			description: 'Enable or disable all breakpoints.'
		}
	},
	required: ['action'],
	additionalProperties: false
};

export const DebugReadToolData: IToolData = {
	id: DebugReadToolId,
	toolReferenceName: 'debugRead',
	displayName: localize('tool.debug.read.displayName', 'Debug Read'),
	userDescription: localize('tool.debug.read.userDescription', 'Inspect debug sessions, threads, stack frames, variables, and breakpoints.'),
	modelDescription: 'Read debug session state. Use this tool to list sessions, threads, stack frames, scopes, variables, evaluate expressions, and list breakpoints. Provide a specific sessionId or sessionName when multiple sessions exist.',
	source: ToolDataSource.Internal,
	when: ChatContextKeys.enabled,
	inputSchema: DebugReadInputSchema
};

export const DebugControlToolData: IToolData = {
	id: DebugControlToolId,
	toolReferenceName: 'debugControl',
	displayName: localize('tool.debug.control.displayName', 'Debug Control'),
	userDescription: localize('tool.debug.control.userDescription', 'Control debug sessions, stepping, and breakpoints.'),
	modelDescription: 'Control debug sessions. Use this tool to step, continue, pause, restart, stop, terminate, and manage breakpoints. Provide a specific sessionId or sessionName when multiple sessions exist.',
	source: ToolDataSource.Internal,
	when: ChatContextKeys.enabled,
	inputSchema: DebugControlInputSchema
};

const HighImpactActions = new Set<DebugControlAction>([
	DebugControlAction.Restart,
	DebugControlAction.Stop,
	DebugControlAction.Terminate,
]);

class DebugToolBase extends Disposable {
	constructor(
		@IDebugService protected readonly debugService: IDebugService,
	) {
		super();
	}

	protected listSessions(params: IDebugReadToolParams): IToolResult {
		const sessions = this.debugService.getModel().getSessions(!!params.includeInactive);
		const focused = this.debugService.getViewModel().focusedSession;
		const data = sessions.map(session => ({
			id: session.getId(),
			name: session.name,
			state: getStateLabel(session.state),
			focused: focused?.getId() === session.getId(),
			parentSessionId: session.parentSession?.getId()
		}));

		return createToolSimpleTextResult(JSON.stringify({ sessions: data }, null, 2));
	}

	protected listThreads(params: IDebugReadToolParams): IToolResult {
		const session = this.resolveSession(params);
		if (!session) {
			return createToolSimpleTextResult('Error: No debug session found.');
		}

		const threads = session.getAllThreads().map(thread => ({
			id: thread.getId(),
			threadId: thread.threadId,
			name: thread.name,
			stopped: thread.stopped
		}));

		return createToolSimpleTextResult(JSON.stringify({ sessionId: session.getId(), threads }, null, 2));
	}

	protected async listStackFrames(params: IDebugReadToolParams): Promise<IToolResult> {
		const { session, thread } = this.resolveThread(params);
		if (!session || !thread) {
			return createToolSimpleTextResult('Error: No debug thread found.');
		}

		await this.debugService.getModel().fetchCallstack(thread);
		const frames = thread.getCallStack().map(frame => ({
			id: frame.getId(),
			frameId: frame.frameId,
			name: frame.name,
			uri: frame.source.uri?.toString(),
			lineNumber: frame.range.startLineNumber,
			column: frame.range.startColumn
		}));

		return createToolSimpleTextResult(JSON.stringify({ sessionId: session.getId(), threadId: thread.threadId, frames }, null, 2));
	}

	protected async listScopes(params: IDebugReadToolParams): Promise<IToolResult> {
		const frame = await this.resolveStackFrame(params);
		if (!frame) {
			return createToolSimpleTextResult('Error: No stack frame found.');
		}

		const scopes = await frame.getScopes();
		const data = scopes.map((scope, index) => ({
			index,
			name: scope.name,
			expensive: scope.expensive,
			hasChildren: scope.hasChildren
		}));

		return createToolSimpleTextResult(JSON.stringify({ frameId: frame.frameId, scopes: data }, null, 2));
	}

	protected async listVariables(params: IDebugReadToolParams): Promise<IToolResult> {
		const frame = await this.resolveStackFrame(params);
		if (!frame) {
			return createToolSimpleTextResult('Error: No stack frame found.');
		}

		const scopes = await frame.getScopes();
		const scope = this.pickScope(scopes, params);
		if (!scope) {
			return createToolSimpleTextResult('Error: No scope found.');
		}

		const variables = await scope.getChildren();
		const data = variables.map(variable => ({
			id: variable.getId(),
			name: variable.name,
			value: variable.value,
			type: variable.type,
			hasChildren: variable.hasChildren,
			reference: variable.reference
		}));

		return createToolSimpleTextResult(JSON.stringify({ frameId: frame.frameId, scope: scope.name, variables: data }, null, 2));
	}

	protected async evaluateExpression(params: IDebugReadToolParams): Promise<IToolResult> {
		if (!params.expression) {
			return createToolSimpleTextResult('Error: expression is required for evaluate.');
		}

		const session = this.resolveSession(params);
		const frame = await this.resolveStackFrame(params);
		if (!session || !frame) {
			return createToolSimpleTextResult('Error: No session or stack frame found.');
		}

		const response = await session.evaluate(params.expression, frame.frameId, 'watch');
		const result = response?.body?.result ?? '';
		const type = response?.body?.type;
		return createToolSimpleTextResult(JSON.stringify({ expression: params.expression, result, type }, null, 2));
	}

	protected listBreakpoints(): IToolResult {
		const breakpoints = this.debugService.getModel().getBreakpoints();
		const data = breakpoints.map(bp => this.serializeBreakpoint(bp));
		return createToolSimpleTextResult(JSON.stringify({ breakpoints: data }, null, 2));
	}

	protected async addBreakpoint(params: IDebugControlToolParams): Promise<IToolResult> {
		if (!params.uri || !params.lineNumber) {
			return createToolSimpleTextResult('Error: uri and lineNumber are required for addBreakpoint.');
		}

		const uri = this.parseUri(params.uri);
		const rawBreakpoint: IBreakpointData = {
			lineNumber: params.lineNumber,
			column: params.column,
			enabled: params.enabled ?? true,
			condition: params.condition,
			hitCondition: params.hitCondition,
			logMessage: params.logMessage
		};
		const breakpoints = await this.debugService.addBreakpoints(uri, [rawBreakpoint], false);
		const data = breakpoints.map(bp => this.serializeBreakpoint(bp));
		return createToolSimpleTextResult(JSON.stringify({ breakpoints: data }, null, 2));
	}

	protected async removeBreakpoint(params: IDebugControlToolParams): Promise<IToolResult> {
		if (params.breakpointId) {
			await this.debugService.removeBreakpoints(params.breakpointId);
			return createToolSimpleTextResult(JSON.stringify({ removed: [params.breakpointId] }, null, 2));
		}

		if (params.uri && params.lineNumber) {
			const uri = this.parseUri(params.uri);
			const breakpoints = this.debugService.getModel().getBreakpoints({ uri, lineNumber: params.lineNumber });
			const ids = breakpoints.map(bp => bp.getId());
			if (ids.length) {
				await this.debugService.removeBreakpoints(ids);
			}
			return createToolSimpleTextResult(JSON.stringify({ removed: ids }, null, 2));
		}

		return createToolSimpleTextResult('Error: breakpointId or uri + lineNumber is required for removeBreakpoint.');
	}

	protected async setBreakpointsActivated(params: IDebugControlToolParams): Promise<IToolResult> {
		if (typeof params.breakpointsActivated !== 'boolean') {
			return createToolSimpleTextResult('Error: breakpointsActivated must be provided for setBreakpointsActivated.');
		}

		await this.debugService.setBreakpointsActivated(params.breakpointsActivated);
		return createToolSimpleTextResult(JSON.stringify({ breakpointsActivated: params.breakpointsActivated }, null, 2));
	}

	protected async controlThread(params: IDebugControlToolParams): Promise<IToolResult> {
		const { session, thread } = this.resolveThread(params);
		if (!session || !thread) {
			return createToolSimpleTextResult('Error: No debug thread found.');
		}

		switch (params.action) {
			case DebugControlAction.Continue:
				await thread.continue();
				break;
			case DebugControlAction.Pause:
				await thread.pause();
				break;
			case DebugControlAction.StepOver:
				await thread.next();
				break;
			case DebugControlAction.StepInto:
				await thread.stepIn();
				break;
			case DebugControlAction.StepOut:
				await thread.stepOut();
				break;
		}

		return createToolSimpleTextResult(JSON.stringify({ action: params.action, sessionId: session.getId(), threadId: thread.threadId }, null, 2));
	}

	protected async controlSession(params: IDebugControlToolParams): Promise<IToolResult> {
		const session = this.resolveSession(params);
		if (!session) {
			return createToolSimpleTextResult('Error: No debug session found.');
		}

		switch (params.action) {
			case DebugControlAction.Restart:
				await this.debugService.restartSession(session);
				break;
			case DebugControlAction.Stop:
				await this.debugService.stopSession(session, false, false);
				break;
			case DebugControlAction.Terminate:
				await session.terminate();
				break;
		}

		return createToolSimpleTextResult(JSON.stringify({ action: params.action, sessionId: session.getId() }, null, 2));
	}

	protected resolveSession(params: { sessionId?: string; sessionName?: string }): IDebugSession | undefined {
		if (params.sessionId) {
			return this.debugService.getModel().getSession(params.sessionId, true);
		}

		if (params.sessionName) {
			const sessions = this.debugService.getModel().getSessions(true);
			return sessions.find(session => session.name === params.sessionName);
		}

		return this.debugService.getViewModel().focusedSession;
	}

	protected resolveThread(params: { sessionId?: string; sessionName?: string; threadId?: number }): { session: IDebugSession | undefined; thread: IThread | undefined } {
		const session = this.resolveSession(params);
		if (session && typeof params.threadId === 'number') {
			return { session, thread: session.getThread(params.threadId) };
		}

		const focusedThread = this.debugService.getViewModel().focusedThread;
		if (focusedThread) {
			return { session: focusedThread.session, thread: focusedThread };
		}

		const sessionThreads = session?.getAllThreads() ?? [];
		return { session, thread: sessionThreads[0] };
	}

	protected async resolveStackFrame(params: { sessionId?: string; sessionName?: string; threadId?: number; frameId?: number }): Promise<IStackFrame | undefined> {
		if (typeof params.frameId === 'number') {
			const { thread } = this.resolveThread(params);
			if (!thread) {
				return undefined;
			}
			await this.debugService.getModel().fetchCallstack(thread);
			return thread.getCallStack().find(frame => frame.frameId === params.frameId);
		}

		return this.debugService.getViewModel().focusedStackFrame;
	}

	protected pickScope(scopes: IScope[], params: { scopeIndex?: number; scopeName?: string }): IScope | undefined {
		if (typeof params.scopeIndex === 'number') {
			return scopes[params.scopeIndex];
		}

		if (params.scopeName) {
			return scopes.find(scope => scope.name === params.scopeName);
		}

		return scopes[0];
	}

	protected parseUri(value: string): URI {
		try {
			const parsed = URI.parse(value);
			if (parsed.scheme) {
				return parsed;
			}
		} catch {
			// ignore and fall back to file path
		}
		return URI.file(value);
	}

	protected serializeBreakpoint(bp: IBreakpoint): object {
		return {
			id: bp.getId(),
			uri: bp.uri.toString(),
			lineNumber: bp.lineNumber,
			column: bp.column,
			enabled: bp.enabled,
			verified: bp.verified,
			condition: bp.condition,
			hitCondition: bp.hitCondition,
			logMessage: bp.logMessage,
			message: bp.message
		};
	}
}

export class DebugReadTool extends DebugToolBase implements IToolImpl {
	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IDebugReadToolParams;
		try {
			switch (params.action) {
				case DebugReadAction.ListSessions:
					return this.listSessions(params);
				case DebugReadAction.ListThreads:
					return this.listThreads(params);
				case DebugReadAction.ListStackFrames:
					return this.listStackFrames(params);
				case DebugReadAction.ListScopes:
					return this.listScopes(params);
				case DebugReadAction.ListVariables:
					return this.listVariables(params);
				case DebugReadAction.Evaluate:
					return this.evaluateExpression(params);
				case DebugReadAction.ListBreakpoints:
					return this.listBreakpoints();
				default:
					return createToolSimpleTextResult('Error: Unsupported debug read action.');
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return createToolSimpleTextResult(`Error: ${message}`);
		}
	}
}

export class DebugControlTool extends DebugToolBase implements IToolImpl {
	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IDebugControlToolParams;
		if (!HighImpactActions.has(params.action)) {
			return undefined;
		}

		const sessionLabel = params.sessionId ?? params.sessionName ?? 'focused session';
		return {
			confirmationMessages: {
				title: localize('tool.debug.control.confirm.title', 'Confirm Debug Action'),
				message: new MarkdownString(localize('tool.debug.control.confirm.message', 'Run **{0}** on **{1}**?', params.action, sessionLabel)),
				allowAutoConfirm: false,
			},
			presentation: ToolInvocationPresentation.HiddenAfterComplete
		};
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IDebugControlToolParams;
		try {
			switch (params.action) {
				case DebugControlAction.AddBreakpoint:
					return this.addBreakpoint(params);
				case DebugControlAction.RemoveBreakpoint:
					return this.removeBreakpoint(params);
				case DebugControlAction.SetBreakpointsActivated:
					return this.setBreakpointsActivated(params);
				case DebugControlAction.Continue:
				case DebugControlAction.Pause:
				case DebugControlAction.StepOver:
				case DebugControlAction.StepInto:
				case DebugControlAction.StepOut:
					return this.controlThread(params);
				case DebugControlAction.Restart:
				case DebugControlAction.Stop:
				case DebugControlAction.Terminate:
					return this.controlSession(params);
				default:
					return createToolSimpleTextResult('Error: Unsupported debug control action.');
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return createToolSimpleTextResult(`Error: ${message}`);
		}
	}
}
