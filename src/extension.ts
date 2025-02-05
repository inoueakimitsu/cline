// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import delay from "delay"
import * as vscode from "vscode"
import * as http from "http"
import { ClineProvider } from "./core/webview/ClineProvider"
import { Logger } from "./services/logging/Logger"
import { createClineAPI } from "./exports"
import "./utils/path" // necessary to have access to String.prototype.toPosix
import { DIFF_VIEW_URI_SCHEME } from "./integrations/editor/DiffViewProvider"

/*
Built using https://github.com/microsoft/vscode-webview-ui-toolkit

Inspired by
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/default/weather-webview
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/frameworks/hello-world-react-cra

*/

let outputChannel: vscode.OutputChannel

// API version and type definitions
const API_VERSION = "1.0"

// Simple type definition
interface APIResponse<T = undefined> {
	success: boolean
	data?: T
	error?: {
		code: string
		message: string
	}
}

// Simple helper function
function sendResponse<T>(res: http.ServerResponse, status: number, response: APIResponse<T>) {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"x-api-version": API_VERSION,
	})
	res.end(JSON.stringify(response))
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel("Cline")
	Logger.initialize(outputChannel)
	Logger.log("Cline extension activated")

	// Get HTTP server settings from configuration
	const config = vscode.workspace.getConfiguration("cline.httpServer")
	const port = config.get<number>("port") || 3000
	const token = config.get<string>("token") || "MY_SECRET_123"

	// Create HTTP server
	Logger.log("Starting HTTP server...")
	const server = http.createServer(async (req, res) => {
		// Set CORS headers
		res.setHeader("Access-Control-Allow-Origin", "*")
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-cli-token")
		res.setHeader("Access-Control-Expose-Headers", "x-api-version")
		res.setHeader("x-api-version", API_VERSION)

		// Handle preflight requests
		if (req.method === "OPTIONS") {
			res.writeHead(204)
			res.end()
			return
		}

		// Validate content type for POST requests
		if (req.method === "POST" && !req.headers["content-type"]?.includes("application/json")) {
			return sendResponse(res, 415, {
				success: false,
				error: {
					code: "INVALID_CONTENT_TYPE",
					message: "Content-Type must be application/json",
				},
			})
		}

		// Validate authentication
		if (req.headers["x-cli-token"] !== token) {
			return sendResponse(res, 401, {
				success: false,
				error: {
					code: "UNAUTHORIZED",
					message: "Invalid or missing authentication token",
				},
			})
		}

		// Route handlers
		try {
			if (req.method === "POST" && req.url === "/v1/messages") {
				let body = ""
				req.on("data", (chunk) => (body += chunk))

				await new Promise((resolve, reject) => {
					req.on("end", resolve)
					req.on("error", reject)
				})

				const { message } = JSON.parse(body)
				if (!message) {
					return sendResponse(res, 400, {
						success: false,
						error: {
							code: "INVALID_REQUEST",
							message: "Message field is required",
						},
					})
				}

				const visibleProvider = ClineProvider.getVisibleInstance()
				if (!visibleProvider) {
					return sendResponse(res, 503, {
						success: false,
						error: {
							code: "SERVICE_UNAVAILABLE",
							message: "No active Cline instance available",
						},
					})
				}

				await vscode.commands.executeCommand("cline.sendMessageExternal", message)
				return sendResponse(res, 200, {
					success: true,
					data: { message: "Message sent successfully" },
				})
			} else if (req.method === "GET" && req.url === "/v1/messages") {
				const visibleProvider = ClineProvider.getVisibleInstance()
				if (!visibleProvider) {
					return sendResponse(res, 503, {
						success: false,
						error: {
							code: "SERVICE_UNAVAILABLE",
							message: "No active Cline instance available",
						},
					})
				}

				const clineMessages = await visibleProvider.getStateToPostToWebview()
				return sendResponse(res, 200, {
					success: true,
					data: clineMessages,
				})
			} else {
				return sendResponse(res, 404, {
					success: false,
					error: {
						code: "NOT_FOUND",
						message: "Requested endpoint not found",
					},
				})
			}
		} catch (error) {
			Logger.log(`API error: ${error.message}`)
			return sendResponse(res, 500, {
				success: false,
				error: {
					code: "INTERNAL_SERVER_ERROR",
					message: "An unexpected error occurred",
				},
			})
		}
	})

	// Start server on configured port
	try {
		server.listen(port, "127.0.0.1", () => {
			Logger.log(`Cline HTTP server running on http://127.0.0.1:${port}`)
			vscode.window.showInformationMessage(`Cline HTTP server started on port ${port}`)
		})

		server.on("error", (error) => {
			Logger.log(`HTTP server error: ${error.message}`)
			vscode.window.showErrorMessage(`Cline HTTP server error: ${error.message}`)
		})
	} catch (error) {
		Logger.log(`Failed to start HTTP server: ${error.message}`)
		vscode.window.showErrorMessage(`Failed to start Cline HTTP server: ${error.message}`)
	}

	// Close server when extension is deactivated
	context.subscriptions.push(new vscode.Disposable(() => server.close()))
	context.subscriptions.push(outputChannel)

	const sidebarProvider = new ClineProvider(context, outputChannel)

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ClineProvider.sideBarId, sidebarProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	// Register command for sending messages from external sources
	context.subscriptions.push(
		vscode.commands.registerCommand("cline.sendMessageExternal", (text: string) => {
			sidebarProvider.postMessageToWebview({
				type: "externalSend",
				command: "externalSend",
				text,
			})
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("cline.plusButtonClicked", async () => {
			Logger.log("Plus button Clicked")
			await sidebarProvider.clearTask()
			await sidebarProvider.postStateToWebview()
			await sidebarProvider.postMessageToWebview({
				type: "action",
				action: "chatButtonClicked",
			})
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("cline.mcpButtonClicked", () => {
			sidebarProvider.postMessageToWebview({
				type: "action",
				action: "mcpButtonClicked",
			})
		}),
	)

	const openClineInNewTab = async () => {
		Logger.log("Opening Cline in new tab")
		// (this example uses webviewProvider activation event which is necessary to deserialize cached webview, but since we use retainContextWhenHidden, we don't need to use that event)
		// https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
		const tabProvider = new ClineProvider(context, outputChannel)
		//const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined
		const lastCol = Math.max(...vscode.window.visibleTextEditors.map((editor) => editor.viewColumn || 0))

		// Check if there are any visible text editors, otherwise open a new group to the right
		const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0
		if (!hasVisibleEditors) {
			await vscode.commands.executeCommand("workbench.action.newGroupRight")
		}
		const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

		const panel = vscode.window.createWebviewPanel(ClineProvider.tabPanelId, "Cline", targetCol, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [context.extensionUri],
		})
		// TODO: use better svg icon with light and dark variants (see https://stackoverflow.com/questions/58365687/vscode-extension-iconpath)

		panel.iconPath = {
			light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "robot_panel_light.png"),
			dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "robot_panel_dark.png"),
		}
		tabProvider.resolveWebviewView(panel)

		// Lock the editor group so clicking on files doesn't open them over the panel
		await delay(100)
		await vscode.commands.executeCommand("workbench.action.lockEditorGroup")
	}

	context.subscriptions.push(vscode.commands.registerCommand("cline.popoutButtonClicked", openClineInNewTab))
	context.subscriptions.push(vscode.commands.registerCommand("cline.openInNewTab", openClineInNewTab))

	context.subscriptions.push(
		vscode.commands.registerCommand("cline.settingsButtonClicked", () => {
			//vscode.window.showInformationMessage(message)
			sidebarProvider.postMessageToWebview({
				type: "action",
				action: "settingsButtonClicked",
			})
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("cline.historyButtonClicked", () => {
			sidebarProvider.postMessageToWebview({
				type: "action",
				action: "historyButtonClicked",
			})
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("cline.accountLoginClicked", () => {
			sidebarProvider.postMessageToWebview({
				type: "action",
				action: "accountLoginClicked",
			})
		}),
	)

	/*
	We use the text document content provider API to show the left side for diff view by creating a virtual document for the original content. This makes it readonly so users know to edit the right side if they want to keep their changes.

	- This API allows you to create readonly documents in VSCode from arbitrary sources, and works by claiming an uri-scheme for which your provider then returns text contents. The scheme must be provided when registering a provider and cannot change afterwards.
	- Note how the provider doesn't create uris for virtual documents - its role is to provide contents given such an uri. In return, content providers are wired into the open document logic so that providers are always considered.
	https://code.visualstudio.com/api/extension-guides/virtual-documents
	*/
	const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
		provideTextDocumentContent(uri: vscode.Uri): string {
			return Buffer.from(uri.query, "base64").toString("utf-8")
		}
	})()
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider))

	// URI Handler
	const handleUri = async (uri: vscode.Uri) => {
		console.log("URI Handler called with:", {
			path: uri.path,
			query: uri.query,
			scheme: uri.scheme,
		})

		const path = uri.path
		const query = new URLSearchParams(uri.query.replace(/\+/g, "%2B"))
		const visibleProvider = ClineProvider.getVisibleInstance()
		if (!visibleProvider) {
			return
		}
		switch (path) {
			case "/openrouter": {
				const code = query.get("code")
				if (code) {
					await visibleProvider.handleOpenRouterCallback(code)
				}
				break
			}
			case "/auth": {
				const token = query.get("token")
				const state = query.get("state")

				console.log("Auth callback received:", {
					token: token,
					state: state,
				})

				// Validate state parameter
				if (!(await visibleProvider.validateAuthState(state))) {
					vscode.window.showErrorMessage("Invalid auth state")
					return
				}

				if (token) {
					await visibleProvider.handleAuthCallback(token)
				}
				break
			}
			default:
				break
		}
	}
	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))

	return createClineAPI(outputChannel, sidebarProvider)
}

// This method is called when your extension is deactivated
export function deactivate() {
	Logger.log("Cline extension deactivated")
}
