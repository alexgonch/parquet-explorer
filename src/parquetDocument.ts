import * as vscode from 'vscode';
import { Disposable } from './dispose';
import { getNonce } from './util';

import * as duckdb from 'duckdb';

interface IMessage {
	type: 'query' | 'more';
	success: boolean;
	message?: string;
	results?: duckdb.TableData;
}

/**
 * Define the document (the data model) used for paw draw files.
 */
class ParquetDocument extends Disposable implements vscode.CustomDocument {

	static async create(
		uri: vscode.Uri,
		backupId: string | undefined,
	): Promise<ParquetDocument | PromiseLike<ParquetDocument>> {
		// If we have a backup, read that. Otherwise read the resource from the workspace
		const trueURI = typeof backupId === 'string' ? vscode.Uri.parse(backupId) : uri;
		return new ParquetDocument(trueURI);
	}

	private readonly _uri: vscode.Uri;
	private readonly _db: duckdb.Database;

	private constructor(uri: vscode.Uri) {
		super();
		this._uri = uri;
		this._db = new duckdb.Database(':memory:');
		this.db.exec(`CREATE VIEW data AS SELECT * FROM read_parquet('${uri.fsPath}');`);
	}

	public get uri() { return this._uri; }
	public get db() { return this._db; }

	private readonly _onDidDispose = this._register(new vscode.EventEmitter<void>());
	/**
	 * Fired when the document is disposed of.
	 */
	public readonly onDidDispose = this._onDidDispose.event;

	/**
	 * Called by VS Code when there are no more references to the document.
	 *
	 * This happens when all editors for it have been closed.
	 */
	dispose(): void {
		this._onDidDispose.fire();
		super.dispose();
	}

	private formatSql(sql: string, limit: number, offset: number): string {
		if (sql.toLowerCase().startsWith('describe')) return sql;
		return `SELECT * FROM (\n${sql.replace(';', '')}\n) LIMIT ${limit} OFFSET ${offset}`;
	}

	private cleanResults(results: duckdb.TableData): duckdb.TableData {
		// DuckDB can sometimes give us BigInt values, which won't JSON.stringify
		// https://github.com/duckdb/duckdb-node/blob/f9a910d544835f55dac36485d767b1c2f6aafb87/src/statement.cpp#L122
		for (const row of results) {
			for (const [key, value] of Object.entries(row)) {
				if (typeof value == "bigint")
					row[key] = Number(value);
			  }
		}
		return results;
	}

	runQuery(sql: string, limit: number, callback: (msg: IMessage) => void): void {
		this.db.all(`EXPLAIN\n${sql}`, (err, res) => {
			if (err) {
				callback({ type: 'query', success: false, message: err.message });
				return;
			}
			this.db.all(
				this.formatSql(sql, limit, 0),
				(err, res) => {
					if (err) {
						callback({ type: 'query', success: false, message: err.message });
						return;
					}
					callback({ type: 'query', success: true, results: this.cleanResults(res) });
				}
			);
		});
	}

	fetchMore(sql: string, limit: number, offset: number, callback: (msg: IMessage) => void): void {
		this.db.all(
			this.formatSql(sql, limit, offset),
			function(err, res) {
				if (err) {
					callback({type: 'more', success: false, message: err.message});
					return;
				}
				callback({type: 'more', success: true, results: res });
			}
		);
	}
}


export class ParquetDocumentProvider implements vscode.CustomReadonlyEditorProvider<ParquetDocument> {

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			ParquetDocumentProvider.viewType,
			new ParquetDocumentProvider(context),
			{supportsMultipleEditorsPerDocument: false},
		);
	}

	private static readonly viewType = 'parquetExplorer.explorer';

	constructor(
		private readonly _context: vscode.ExtensionContext
	) { }

	async openCustomDocument(
		uri: vscode.Uri,
		openContext: { backupId?: string },
		_token: vscode.CancellationToken
	): Promise<ParquetDocument> {
		const document: ParquetDocument = await ParquetDocument.create(uri, openContext.backupId);

		return document;
	}

	async resolveCustomEditor(
		document: ParquetDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		// Setup initial content for the webview
		webviewPanel.webview.options = {
			enableScripts: true,
		};

		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

		webviewPanel.webview.onDidReceiveMessage(e => this.onMessage(document, webviewPanel, e));
	}


	/**
	 * Get the static HTML used for in our editor's webviews.
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		// Local path to script and css for the webview
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'parquetExplorer.js'));

		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'parquetExplorer.css'));
		
		const codeInputJsUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'code-input.min.js'));

		const codeInputCssUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'code-input.min.css'));

		const indentJsUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'indent.min.js'));

		const prismJsUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'prism.js'));

		const prismCssUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'prism.css'));

		const loadingIconUri = webview.asWebviewUri(vscode.Uri.joinPath(
			this._context.extensionUri, 'media', 'loading_icon.gif'));


		// Use a nonce to whitelist which scripts can be run
		const nonce = getNonce();

		return `
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
				Use a content security policy to only allow loading images from https or from our extension directory,
				and only allow scripts that have a specific nonce.
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<script nonce="${nonce}" src="${prismJsUri}"></script>
				<link rel="stylesheet" href="${prismCssUri}">

				<script nonce="${nonce}" src="${codeInputJsUri}"></script>
				<link rel="stylesheet" href="${codeInputCssUri}">

				<script nonce="${nonce}" src="${indentJsUri}"></script>

				<script nonce="${nonce}" src="${jsUri}"></script>
				<link rel="stylesheet" href="${cssUri}">

				<title>Parquet Explorer</title>
			</head>
			<body>
				<div id="wrapper">
				<div id="controls">
					<code-input nonce="${nonce}" lang="SQL"></code-input>
				</div>
				</div>
				<center>
					<table id="results">
						<thead id="resultsHeader"></thead>
						<tbody id="resultsBody"></tbody>
					</table>
					<img id="loadingIcon" src="${loadingIconUri}" />
				</center>
				
			</body>
			
			</html>
		`;
	}


	private postMessage(panel: vscode.WebviewPanel, message: IMessage): void {
		panel.webview.postMessage(message);
	}

	private onMessage(document: ParquetDocument, panel: vscode.WebviewPanel, message: any) {
		switch (message.type) {
			case 'query':
				document.runQuery(message.sql,  message.limit, (msg: IMessage) => this.postMessage(panel, msg));
				return;
			case 'more':
				document.fetchMore(message.sql, message.limit, message.offset, (msg: IMessage) => this.postMessage(panel, msg));
				return;

		}
	}
}
