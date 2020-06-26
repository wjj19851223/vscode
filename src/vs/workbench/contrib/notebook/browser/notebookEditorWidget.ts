/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getZoomLevel } from 'vs/base/browser/browser';
import * as DOM from 'vs/base/browser/dom';
import { IMouseWheelEvent, StandardMouseEvent } from 'vs/base/browser/mouseEvent';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { Color, RGBA } from 'vs/base/common/color';
import { onUnexpectedError } from 'vs/base/common/errors';
import { Emitter, Event } from 'vs/base/common/event';
import { combinedDisposable, DisposableStore, Disposable, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import 'vs/css!./media/notebook';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { BareFontInfo } from 'vs/editor/common/config/fontInfo';
import { Range } from 'vs/editor/common/core/range';
import { IEditor } from 'vs/editor/common/editorCommon';
import * as nls from 'vs/nls';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IResourceEditorInput } from 'vs/platform/editor/common/editor';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { contrastBorder, editorBackground, focusBorder, foreground, registerColor, textBlockQuoteBackground, textBlockQuoteBorder, textLinkActiveForeground, textLinkForeground, textPreformatForeground, errorForeground, transparent } from 'vs/platform/theme/common/colorRegistry';
import { registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { EditorMemento } from 'vs/workbench/browser/parts/editor/baseEditor';
import { EditorOptions, IEditorMemento } from 'vs/workbench/common/editor';
import { CELL_MARGIN, CELL_RUN_GUTTER, EDITOR_BOTTOM_PADDING, EDITOR_TOP_MARGIN, EDITOR_TOP_PADDING, SCROLLABLE_ELEMENT_PADDING_TOP, BOTTOM_CELL_TOOLBAR_HEIGHT, CELL_BOTTOM_MARGIN, CODE_CELL_LEFT_MARGIN } from 'vs/workbench/contrib/notebook/browser/constants';
import { CellEditState, CellFocusMode, ICellRange, ICellViewModel, INotebookCellList, INotebookEditor, INotebookEditorContribution, INotebookEditorMouseEvent, NotebookLayoutInfo, NOTEBOOK_EDITOR_EDITABLE, NOTEBOOK_EDITOR_EXECUTING_NOTEBOOK, NOTEBOOK_EDITOR_FOCUSED, NOTEBOOK_EDITOR_RUNNABLE, NOTEBOOK_HAS_MULTIPLE_KERNELS, NOTEBOOK_OUTPUT_FOCUSED } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { NotebookEditorExtensionsRegistry } from 'vs/workbench/contrib/notebook/browser/notebookEditorExtensions';
import { NotebookCellList } from 'vs/workbench/contrib/notebook/browser/view/notebookCellList';
import { OutputRenderer } from 'vs/workbench/contrib/notebook/browser/view/output/outputRenderer';
import { BackLayerWebView } from 'vs/workbench/contrib/notebook/browser/view/renderers/backLayerWebView';
import { CellDragAndDropController, CodeCellRenderer, MarkdownCellRenderer, NotebookCellListDelegate } from 'vs/workbench/contrib/notebook/browser/view/renderers/cellRenderer';
import { CodeCellViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/codeCellViewModel';
import { NotebookEventDispatcher, NotebookLayoutChangedEvent } from 'vs/workbench/contrib/notebook/browser/viewModel/eventDispatcher';
import { CellViewModel, IModelDecorationsChangeAccessor, INotebookEditorViewState, NotebookViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/notebookViewModel';
import { CellKind, IProcessedOutput, INotebookKernelInfo, INotebookKernelInfoDto } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { INotebookService } from 'vs/workbench/contrib/notebook/common/notebookService';
import { Webview } from 'vs/workbench/contrib/webview/browser/webview';
import { IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { ILayoutService } from 'vs/platform/layout/browser/layoutService';
import { generateUuid } from 'vs/base/common/uuid';
import { Memento, MementoObject } from 'vs/workbench/common/memento';
import { NotebookTextModel } from 'vs/workbench/contrib/notebook/common/model/notebookTextModel';
import { URI } from 'vs/base/common/uri';
import { PANEL_BORDER } from 'vs/workbench/common/theme';
import { debugIconStartForeground } from 'vs/workbench/contrib/debug/browser/debugToolBar';
import { CellContextKeyManager } from 'vs/workbench/contrib/notebook/browser/view/renderers/cellContextKeys';

const $ = DOM.$;

export class NotebookEditorOptions extends EditorOptions {

	readonly cellOptions?: IResourceEditorInput;

	constructor(options: Partial<NotebookEditorOptions>) {
		super();
		this.overwrite(options);
		this.cellOptions = options.cellOptions;
	}

	with(options: Partial<NotebookEditorOptions>): NotebookEditorOptions {
		return new NotebookEditorOptions({ ...this, ...options });
	}
}

export class NotebookEditorWidget extends Disposable implements INotebookEditor {
	static readonly ID: string = 'workbench.editor.notebook';
	private static readonly EDITOR_MEMENTOS = new Map<string, EditorMemento<unknown>>();
	private _overlayContainer!: HTMLElement;
	private _body!: HTMLElement;
	private _webview: BackLayerWebView | null = null;
	private _webviewTransparentCover: HTMLElement | null = null;
	private _list: INotebookCellList | undefined;
	private _dndController: CellDragAndDropController | null = null;
	private _renderedEditors: Map<ICellViewModel, ICodeEditor | undefined> = new Map();
	private _eventDispatcher: NotebookEventDispatcher | undefined;
	private _notebookViewModel: NotebookViewModel | undefined;
	private _localStore: DisposableStore = this._register(new DisposableStore());
	private _fontInfo: BareFontInfo | undefined;
	private _dimension: DOM.Dimension | null = null;
	private _shadowElementViewInfo: { height: number, width: number, top: number; left: number; } | null = null;
	private _editorFocus: IContextKey<boolean> | null = null;
	private _outputFocus: IContextKey<boolean> | null = null;
	private _editorEditable: IContextKey<boolean> | null = null;
	private _editorRunnable: IContextKey<boolean> | null = null;
	private _editorExecutingNotebook: IContextKey<boolean> | null = null;
	private _notebookHasMultipleKernels: IContextKey<boolean> | null = null;
	private _outputRenderer: OutputRenderer;
	protected readonly _contributions: { [key: string]: INotebookEditorContribution; };
	private _scrollBeyondLastLine: boolean;
	private readonly _memento: Memento;
	private readonly _onDidFocusEmitter = this._register(new Emitter<void>());
	public readonly onDidFocus = this._onDidFocusEmitter.event;
	private _cellContextKeyManager: CellContextKeyManager | null = null;
	private _isVisible = false;
	private readonly _uuid = generateUuid();

	private _isDisposed: boolean = false;

	get isDisposed() {
		return this._isDisposed;
	}

	private readonly _onDidChangeModel = this._register(new Emitter<NotebookTextModel | undefined>());
	readonly onDidChangeModel: Event<NotebookTextModel | undefined> = this._onDidChangeModel.event;

	private readonly _onDidFocusEditorWidget = this._register(new Emitter<void>());
	readonly onDidFocusEditorWidget = this._onDidFocusEditorWidget.event;

	set viewModel(newModel: NotebookViewModel | undefined) {
		this._notebookViewModel = newModel;
		this._onDidChangeModel.fire(newModel?.notebookDocument);
	}

	get viewModel() {
		return this._notebookViewModel;
	}

	get uri() {
		return this._notebookViewModel?.uri;
	}

	get textModel() {
		return this._notebookViewModel?.notebookDocument;
	}

	private _activeKernel: INotebookKernelInfo | undefined = undefined;
	private readonly _onDidChangeKernel = this._register(new Emitter<void>());
	readonly onDidChangeKernel: Event<void> = this._onDidChangeKernel.event;

	get activeKernel() {
		return this._activeKernel;
	}

	set activeKernel(kernel: INotebookKernelInfo | undefined) {
		if (this._isDisposed) {
			return;
		}

		this._activeKernel = kernel;
		this._onDidChangeKernel.fire();
	}

	private readonly _onDidChangeActiveEditor = this._register(new Emitter<this>());
	readonly onDidChangeActiveEditor: Event<this> = this._onDidChangeActiveEditor.event;

	get activeCodeEditor(): IEditor | undefined {
		if (this._isDisposed) {
			return;
		}

		const [focused] = this._list!.getFocusedElements();
		return this._renderedEditors.get(focused);
	}

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@INotebookService private notebookService: INotebookService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService readonly contextKeyService: IContextKeyService,
		@ILayoutService private readonly layoutService: ILayoutService
	) {
		super();
		this._memento = new Memento(NotebookEditorWidget.ID, storageService);

		this._outputRenderer = new OutputRenderer(this, this.instantiationService);
		this._contributions = {};
		this._scrollBeyondLastLine = this.configurationService.getValue<boolean>('editor.scrollBeyondLastLine');

		this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('editor.scrollBeyondLastLine')) {
				this._scrollBeyondLastLine = this.configurationService.getValue<boolean>('editor.scrollBeyondLastLine');
				if (this._dimension && this._isVisible) {
					this.layout(this._dimension);
				}
			}
		});

		this.notebookService.addNotebookEditor(this);
	}

	public getId(): string {
		return this._uuid;
	}

	hasModel() {
		return !!this._notebookViewModel;
	}

	//#region Editor Core

	protected getEditorMemento<T>(editorGroupService: IEditorGroupsService, key: string, limit: number = 10): IEditorMemento<T> {
		const mementoKey = `${NotebookEditorWidget.ID}${key}`;

		let editorMemento = NotebookEditorWidget.EDITOR_MEMENTOS.get(mementoKey);
		if (!editorMemento) {
			editorMemento = new EditorMemento(NotebookEditorWidget.ID, key, this.getMemento(StorageScope.WORKSPACE), limit, editorGroupService);
			NotebookEditorWidget.EDITOR_MEMENTOS.set(mementoKey, editorMemento);
		}

		return editorMemento as IEditorMemento<T>;
	}

	protected getMemento(scope: StorageScope): MementoObject {
		return this._memento.getMemento(scope);
	}

	public get isNotebookEditor() {
		return true;
	}

	updateEditorFocus() {
		// Note - focus going to the webview will fire 'blur', but the webview element will be
		// a descendent of the notebook editor root.
		const focused = DOM.isAncestor(document.activeElement, this._overlayContainer);
		this._editorFocus?.set(focused);
		this._notebookViewModel?.setFocus(focused);
	}

	hasFocus() {
		return this._editorFocus?.get() || false;
	}

	createEditor(): void {
		this._overlayContainer = document.createElement('div');
		const id = generateUuid();
		this._overlayContainer.id = `notebook-${id}`;
		this._overlayContainer.className = 'notebookOverlay';
		DOM.addClass(this._overlayContainer, 'notebook-editor');
		this._overlayContainer.style.visibility = 'hidden';

		this.layoutService.container.appendChild(this._overlayContainer);
		this._createBody(this._overlayContainer);
		this._generateFontInfo();
		this._editorFocus = NOTEBOOK_EDITOR_FOCUSED.bindTo(this.contextKeyService);
		this._editorFocus.set(true);
		this._isVisible = true;
		this._outputFocus = NOTEBOOK_OUTPUT_FOCUSED.bindTo(this.contextKeyService);
		this._editorEditable = NOTEBOOK_EDITOR_EDITABLE.bindTo(this.contextKeyService);
		this._editorEditable.set(true);
		this._editorRunnable = NOTEBOOK_EDITOR_RUNNABLE.bindTo(this.contextKeyService);
		this._editorRunnable.set(true);
		this._editorExecutingNotebook = NOTEBOOK_EDITOR_EXECUTING_NOTEBOOK.bindTo(this.contextKeyService);
		this._notebookHasMultipleKernels = NOTEBOOK_HAS_MULTIPLE_KERNELS.bindTo(this.contextKeyService);
		this._notebookHasMultipleKernels.set(false);

		const contributions = NotebookEditorExtensionsRegistry.getEditorContributions();

		for (const desc of contributions) {
			try {
				const contribution = this.instantiationService.createInstance(desc.ctor, this);
				this._contributions[desc.id] = contribution;
			} catch (err) {
				onUnexpectedError(err);
			}
		}
	}

	private _generateFontInfo(): void {
		const editorOptions = this.configurationService.getValue<IEditorOptions>('editor');
		this._fontInfo = BareFontInfo.createFromRawSettings(editorOptions, getZoomLevel());
	}

	private _createBody(parent: HTMLElement): void {
		this._body = document.createElement('div');
		DOM.addClass(this._body, 'cell-list-container');
		this._createCellList();
		DOM.append(parent, this._body);
	}

	private _createCellList(): void {
		DOM.addClass(this._body, 'cell-list-container');

		this._dndController = this._register(new CellDragAndDropController(this, this._body));
		const getScopedContextKeyService = (container?: HTMLElement) => this._list!.contextKeyService.createScoped(container);
		const renderers = [
			this.instantiationService.createInstance(CodeCellRenderer, this, this._renderedEditors, this._dndController, getScopedContextKeyService),
			this.instantiationService.createInstance(MarkdownCellRenderer, this, this._dndController, this._renderedEditors, getScopedContextKeyService),
		];

		this._list = this.instantiationService.createInstance(
			NotebookCellList,
			'NotebookCellList',
			this._body,
			this.instantiationService.createInstance(NotebookCellListDelegate),
			renderers,
			this.contextKeyService,
			{
				setRowLineHeight: false,
				setRowHeight: false,
				supportDynamicHeights: true,
				horizontalScrolling: false,
				keyboardSupport: false,
				mouseSupport: true,
				multipleSelectionSupport: false,
				enableKeyboardNavigation: true,
				additionalScrollHeight: 0,
				transformOptimization: false,
				styleController: (_suffix: string) => { return this._list!; },
				overrideStyles: {
					listBackground: Color.transparent,
					listActiveSelectionBackground: Color.transparent,
					listActiveSelectionForeground: foreground,
					listFocusAndSelectionBackground: Color.transparent,
					listFocusAndSelectionForeground: foreground,
					listFocusBackground: Color.transparent,
					listFocusForeground: foreground,
					listHoverForeground: foreground,
					listHoverBackground: Color.transparent,
					listHoverOutline: focusBorder,
					listFocusOutline: focusBorder,
					listInactiveSelectionBackground: Color.transparent,
					listInactiveSelectionForeground: foreground,
					listInactiveFocusBackground: Color.transparent,
					listInactiveFocusOutline: Color.transparent,
				},
				accessibilityProvider: {
					getAriaLabel() { return null; },
					getWidgetAriaLabel() {
						return nls.localize('notebookTreeAriaLabel', "Notebook");
					}
				}
			},
		);
		this._dndController.setList(this._list);

		// create Webview

		this._register(this._list);
		this._register(combinedDisposable(...renderers));

		// transparent cover
		this._webviewTransparentCover = DOM.append(this._list.rowsContainer, $('.webview-cover'));
		this._webviewTransparentCover.style.display = 'none';

		this._register(DOM.addStandardDisposableGenericMouseDownListner(this._overlayContainer, (e: StandardMouseEvent) => {
			if (DOM.hasClass(e.target, 'slider') && this._webviewTransparentCover) {
				this._webviewTransparentCover.style.display = 'block';
			}
		}));

		this._register(DOM.addStandardDisposableGenericMouseUpListner(this._overlayContainer, () => {
			if (this._webviewTransparentCover) {
				// no matter when
				this._webviewTransparentCover.style.display = 'none';
			}
		}));

		this._register(this._list.onMouseDown(e => {
			if (e.element) {
				this._onMouseDown.fire({ event: e.browserEvent, target: e.element });
			}
		}));

		this._register(this._list.onMouseUp(e => {
			if (e.element) {
				this._onMouseUp.fire({ event: e.browserEvent, target: e.element });
			}
		}));

		this._register(this._list.onDidChangeFocus(_e => this._onDidChangeActiveEditor.fire(this)));

		const widgetFocusTracker = DOM.trackFocus(this.getDomNode());
		this._register(widgetFocusTracker);
		this._register(widgetFocusTracker.onDidFocus(() => this._onDidFocusEmitter.fire()));
	}

	getDomNode() {
		return this._overlayContainer;
	}

	onWillHide() {
		this._isVisible = false;
		this._editorFocus?.set(false);
		this._overlayContainer.style.visibility = 'hidden';
		this._overlayContainer.style.left = '-50000px';
	}

	getInnerWebview(): Webview | undefined {
		return this._webview?.webview;
	}

	focus() {
		this._isVisible = true;
		this._editorFocus?.set(true);

		const focus = this._list?.getFocus()[0];
		if (typeof focus === 'number') {
			const element = this._notebookViewModel!.viewCells[focus];

			if (element.focusMode === CellFocusMode.Editor) {
				element.editState = CellEditState.Editing;
				element.focusMode = CellFocusMode.Editor;
				this._onDidFocusEditorWidget.fire();
				return;
			}

		}
		this._list?.domFocus();
		this._onDidFocusEditorWidget.fire();
	}

	async setModel(textModel: NotebookTextModel, viewState: INotebookEditorViewState | undefined): Promise<void> {
		if (this._notebookViewModel === undefined || !this._notebookViewModel.equal(textModel)) {
			this._detachModel();
			await this._attachModel(textModel, viewState);
		} else {
			this.restoreListViewState(viewState);
		}

		// clear state
		this._dndController?.clearGlobalDragState();

		this._setKernels(textModel);

		this._localStore.add(this.notebookService.onDidChangeKernels(() => {
			if (this.activeKernel === undefined) {
				this._setKernels(textModel);
			}
		}));

		this._localStore.add(this._list!.onDidChangeFocus(() => {
			const focused = this._list!.getFocusedElements()[0];
			if (focused) {
				if (!this._cellContextKeyManager) {
					this._cellContextKeyManager = this._localStore.add(new CellContextKeyManager(this.contextKeyService, textModel, focused as CellViewModel));
				}

				this._cellContextKeyManager.updateForElement(focused as CellViewModel);
			}
		}));
	}

	async setOptions(options: NotebookEditorOptions | undefined) {
		// reveal cell if editor options tell to do so
		if (options?.cellOptions) {
			const cellOptions = options.cellOptions;
			const cell = this._notebookViewModel!.viewCells.find(cell => cell.uri.toString() === cellOptions.resource.toString());
			if (cell) {
				this.selectElement(cell);
				this.revealInCenterIfOutsideViewport(cell);
				const editor = this._renderedEditors.get(cell)!;
				if (editor) {
					if (cellOptions.options?.selection) {
						const { selection } = cellOptions.options;
						editor.setSelection({
							...selection,
							endLineNumber: selection.endLineNumber || selection.startLineNumber,
							endColumn: selection.endColumn || selection.startColumn
						});
						editor.revealPositionInCenterIfOutsideViewport({
							lineNumber: selection.startLineNumber,
							column: selection.startColumn
						});
					}
					if (!cellOptions.options?.preserveFocus) {
						editor.focus();
					}
				}
			}
		} else if (this._notebookViewModel && this._notebookViewModel.viewCells.length === 1 && this._notebookViewModel.viewCells[0].cellKind === CellKind.Code) {
			// there is only one code cell in the document
			const cell = this._notebookViewModel!.viewCells[0];
			if (cell.getTextLength() === 0) {
				// the cell is empty, very likely a template cell, focus it
				this.selectElement(cell);
				await this.revealLineInCenterAsync(cell, 1);
				const editor = this._renderedEditors.get(cell)!;
				if (editor) {
					editor.focus();
				}
			}
		}
	}

	private _detachModel() {
		this._localStore.clear();
		this._list?.detachViewModel();
		this.viewModel?.dispose();
		// avoid event
		this._notebookViewModel = undefined;
		// this.webview?.clearInsets();
		// this.webview?.clearPreloadsCache();
		this._webview?.dispose();
		this._webview?.element.remove();
		this._webview = null;
		this._list?.clear();
	}

	private _setKernels(textModel: NotebookTextModel) {
		const provider = this.notebookService.getContributedNotebookProviders(this.viewModel!.uri)[0];
		const availableKernels = this.notebookService.getContributedNotebookKernels(textModel.viewType, textModel.uri);

		if (provider.kernel && availableKernels.length > 0) {
			this._notebookHasMultipleKernels!.set(true);
		} else if (availableKernels.length > 1) {
			this._notebookHasMultipleKernels!.set(true);
		} else {
			this._notebookHasMultipleKernels!.set(false);
		}

		if (provider && provider.kernel) {
			// it has a builtin kernel, don't automatically choose a kernel
			this._loadKernelPreloads(provider.providerExtensionLocation, provider.kernel);
			return;
		}

		// the provider doesn't have a builtin kernel, choose a kernel
		this.activeKernel = availableKernels[0];
		if (this.activeKernel) {
			this._loadKernelPreloads(this.activeKernel.extensionLocation, this.activeKernel);
		}
	}

	private _loadKernelPreloads(extensionLocation: URI, kernel: INotebookKernelInfoDto) {
		if (kernel.preloads) {
			this._webview?.updateKernelPreloads([extensionLocation], kernel.preloads.map(preload => URI.revive(preload)));
		}
	}

	private _updateForMetadata(): void {
		this._editorEditable?.set(!!this.viewModel!.metadata?.editable);
		this._editorRunnable?.set(!!this.viewModel!.metadata?.runnable);
		DOM.toggleClass(this._overlayContainer, 'notebook-editor-editable', !!this.viewModel!.metadata?.editable);
		DOM.toggleClass(this.getDomNode(), 'notebook-editor-editable', !!this.viewModel!.metadata?.editable);
	}

	private async _createWebview(id: string, document: URI): Promise<void> {
		this._webview = this.instantiationService.createInstance(BackLayerWebView, this, id, document);
		// attach the webview container to the DOM tree first
		this._list?.rowsContainer.insertAdjacentElement('afterbegin', this._webview.element);
		await this._webview.createWebview();
		this._webview.webview.onDidBlur(() => {
			this._outputFocus?.set(false);
			this.updateEditorFocus();
		});
		this._webview.webview.onDidFocus(() => {
			this._outputFocus?.set(true);
			this.updateEditorFocus();
			this._onDidFocusEmitter.fire();
		});

		this._localStore.add(this._webview.onMessage(({ message, forRenderer }) => {
			if (this.viewModel) {
				this.notebookService.onDidReceiveMessage(this.viewModel.viewType, this.getId(), forRenderer, message);
			}
		}));
	}

	private async _attachModel(textModel: NotebookTextModel, viewState: INotebookEditorViewState | undefined) {
		await this._createWebview(this.getId(), textModel.uri);

		this._eventDispatcher = new NotebookEventDispatcher();
		this.viewModel = this.instantiationService.createInstance(NotebookViewModel, textModel.viewType, textModel, this._eventDispatcher, this.getLayoutInfo());
		this._eventDispatcher.emit([new NotebookLayoutChangedEvent({ width: true, fontInfo: true }, this.getLayoutInfo())]);

		this._updateForMetadata();
		this._localStore.add(this._eventDispatcher.onDidChangeMetadata(() => {
			this._updateForMetadata();
		}));

		// restore view states, including contributions

		{
			// restore view state
			this.viewModel.restoreEditorViewState(viewState);

			// contribution state restore

			const contributionsState = viewState?.contributionsState || {};
			const keys = Object.keys(this._contributions);
			for (let i = 0, len = keys.length; i < len; i++) {
				const id = keys[i];
				const contribution = this._contributions[id];
				if (typeof contribution.restoreViewState === 'function') {
					contribution.restoreViewState(contributionsState[id]);
				}
			}
		}

		this._webview?.updateRendererPreloads(this.viewModel.renderers);

		this._localStore.add(this._list!.onWillScroll(e => {
			this._webview!.updateViewScrollTop(-e.scrollTop, []);
			this._webviewTransparentCover!.style.top = `${e.scrollTop}px`;
		}));

		this._localStore.add(this._list!.onDidChangeContentHeight(() => {
			DOM.scheduleAtNextAnimationFrame(() => {
				if (this._isDisposed) {
					return;
				}

				const scrollTop = this._list?.scrollTop || 0;
				const scrollHeight = this._list?.scrollHeight || 0;
				this._webview!.element.style.height = `${scrollHeight}px`;

				if (this._webview?.insetMapping) {
					let updateItems: { cell: CodeCellViewModel, output: IProcessedOutput, cellTop: number }[] = [];
					let removedItems: IProcessedOutput[] = [];
					this._webview?.insetMapping.forEach((value, key) => {
						const cell = value.cell;
						const viewIndex = this._list?.getViewIndex(cell);

						if (viewIndex === undefined) {
							return;
						}

						if (cell.outputs.indexOf(key) < 0) {
							// output is already gone
							removedItems.push(key);
						}

						const cellTop = this._list?.getAbsoluteTopOfElement(cell) || 0;
						if (this._webview!.shouldUpdateInset(cell, key, cellTop)) {
							updateItems.push({
								cell: cell,
								output: key,
								cellTop: cellTop
							});
						}
					});

					removedItems.forEach(output => this._webview?.removeInset(output));

					if (updateItems.length) {
						this._webview?.updateViewScrollTop(-scrollTop, updateItems);
					}
				}
			});
		}));

		this._list!.attachViewModel(this.viewModel);
		this._localStore.add(this._list!.onDidRemoveOutput(output => {
			this.removeInset(output);
		}));
		this._localStore.add(this._list!.onDidHideOutput(output => {
			this.hideInset(output);
		}));

		this._list!.layout();
		this._dndController?.clearGlobalDragState();

		// restore list state at last, it must be after list layout
		this.restoreListViewState(viewState);
	}

	restoreListViewState(viewState: INotebookEditorViewState | undefined): void {
		if (viewState?.scrollPosition !== undefined) {
			this._list!.scrollTop = viewState!.scrollPosition.top;
			this._list!.scrollLeft = viewState!.scrollPosition.left;
		} else {
			this._list!.scrollTop = 0;
			this._list!.scrollLeft = 0;
		}

		const focusIdx = typeof viewState?.focus === 'number' ? viewState.focus : 0;
		if (focusIdx < this._list!.length) {
			this._list!.setFocus([focusIdx]);
			this._list!.setSelection([focusIdx]);
		} else if (this._list!.length > 0) {
			this._list!.setFocus([0]);
		}

		if (viewState?.editorFocused) {
			this._list?.focusView();
			const cell = this._notebookViewModel?.viewCells[focusIdx];
			if (cell) {
				cell.focusMode = CellFocusMode.Editor;
			}
		}
	}

	getEditorViewState(): INotebookEditorViewState {
		const state = this._notebookViewModel?.getEditorViewState();
		if (!state) {
			return {
				editingCells: {},
				editorViewStates: {}
			};
		}

		if (this._list) {
			state.scrollPosition = { left: this._list.scrollLeft, top: this._list.scrollTop };
			let cellHeights: { [key: number]: number } = {};
			for (let i = 0; i < this.viewModel!.length; i++) {
				const elm = this.viewModel!.viewCells[i] as CellViewModel;
				if (elm.cellKind === CellKind.Code) {
					cellHeights[i] = elm.layoutInfo.totalHeight;
				} else {
					cellHeights[i] = 0;
				}
			}

			state.cellTotalHeights = cellHeights;

			const focus = this._list.getFocus()[0];
			if (typeof focus === 'number') {
				const element = this._notebookViewModel!.viewCells[focus];
				if (element) {
					const itemDOM = this._list?.domElementOfElement(element);
					let editorFocused = !!(document.activeElement && itemDOM && itemDOM.contains(document.activeElement));

					state.editorFocused = editorFocused;
					state.focus = focus;
				}
			}
		}

		// Save contribution view states
		const contributionsState: { [key: string]: unknown } = {};

		const keys = Object.keys(this._contributions);
		for (const id of keys) {
			const contribution = this._contributions[id];
			if (typeof contribution.saveViewState === 'function') {
				contributionsState[id] = contribution.saveViewState();
			}
		}

		state.contributionsState = contributionsState;
		return state;
	}

	// private saveEditorViewState(input: NotebookEditorInput): void {
	// 	if (this.group && this.notebookViewModel) {
	// 	}
	// }

	// private loadTextEditorViewState(): INotebookEditorViewState | undefined {
	// 	return this.editorMemento.loadEditorState(this.group, input.resource);
	// }

	layout(dimension: DOM.Dimension, shadowElement?: HTMLElement): void {
		if (!shadowElement && this._shadowElementViewInfo === null) {
			this._dimension = dimension;
			return;
		}

		if (shadowElement) {
			const containerRect = shadowElement.getBoundingClientRect();

			this._shadowElementViewInfo = {
				height: containerRect.height,
				width: containerRect.width,
				top: containerRect.top,
				left: containerRect.left
			};
		}

		this._dimension = new DOM.Dimension(dimension.width, dimension.height);
		DOM.size(this._body, dimension.width, dimension.height);
		this._list?.updateOptions({ additionalScrollHeight: this._scrollBeyondLastLine ? dimension.height - SCROLLABLE_ELEMENT_PADDING_TOP : 0 });
		this._list?.layout(dimension.height - SCROLLABLE_ELEMENT_PADDING_TOP, dimension.width);

		this._overlayContainer.style.visibility = 'visible';
		this._overlayContainer.style.display = 'block';
		this._overlayContainer.style.position = 'absolute';
		this._overlayContainer.style.top = `${this._shadowElementViewInfo!.top}px`;
		this._overlayContainer.style.left = `${this._shadowElementViewInfo!.left}px`;
		this._overlayContainer.style.width = `${dimension ? dimension.width : this._shadowElementViewInfo!.width}px`;
		this._overlayContainer.style.height = `${dimension ? dimension.height : this._shadowElementViewInfo!.height}px`;

		if (this._webviewTransparentCover) {
			this._webviewTransparentCover.style.height = `${dimension.height}px`;
			this._webviewTransparentCover.style.width = `${dimension.width}px`;
		}

		this._eventDispatcher?.emit([new NotebookLayoutChangedEvent({ width: true, fontInfo: true }, this.getLayoutInfo())]);
	}

	// protected saveState(): void {
	// 	if (this.input instanceof NotebookEditorInput) {
	// 		this.saveEditorViewState(this.input);
	// 	}

	// 	super.saveState();
	// }

	//#endregion

	//#region Editor Features

	selectElement(cell: ICellViewModel) {
		this._list?.selectElement(cell);
		// this.viewModel!.selectionHandles = [cell.handle];
	}

	revealInView(cell: ICellViewModel) {
		this._list?.revealElementInView(cell);
	}

	revealInCenterIfOutsideViewport(cell: ICellViewModel) {
		this._list?.revealElementInCenterIfOutsideViewport(cell);
	}

	revealInCenter(cell: ICellViewModel) {
		this._list?.revealElementInCenter(cell);
	}

	async revealLineInViewAsync(cell: ICellViewModel, line: number): Promise<void> {
		return this._list?.revealElementLineInViewAsync(cell, line);
	}

	async revealLineInCenterAsync(cell: ICellViewModel, line: number): Promise<void> {
		return this._list?.revealElementLineInCenterAsync(cell, line);
	}

	async revealLineInCenterIfOutsideViewportAsync(cell: ICellViewModel, line: number): Promise<void> {
		return this._list?.revealElementLineInCenterIfOutsideViewportAsync(cell, line);
	}

	async revealRangeInViewAsync(cell: ICellViewModel, range: Range): Promise<void> {
		return this._list?.revealElementRangeInViewAsync(cell, range);
	}

	async revealRangeInCenterAsync(cell: ICellViewModel, range: Range): Promise<void> {
		return this._list?.revealElementRangeInCenterAsync(cell, range);
	}

	async revealRangeInCenterIfOutsideViewportAsync(cell: ICellViewModel, range: Range): Promise<void> {
		return this._list?.revealElementRangeInCenterIfOutsideViewportAsync(cell, range);
	}

	setCellSelection(cell: ICellViewModel, range: Range): void {
		this._list?.setCellSelection(cell, range);
	}

	changeDecorations<T>(callback: (changeAccessor: IModelDecorationsChangeAccessor) => T): T | null {
		return this._notebookViewModel?.changeDecorations<T>(callback) || null;
	}

	setHiddenAreas(_ranges: ICellRange[]): boolean {
		return this._list!.setHiddenAreas(_ranges, true);
	}

	//#endregion

	//#region Mouse Events
	private readonly _onMouseUp: Emitter<INotebookEditorMouseEvent> = this._register(new Emitter<INotebookEditorMouseEvent>());
	public readonly onMouseUp: Event<INotebookEditorMouseEvent> = this._onMouseUp.event;

	private readonly _onMouseDown: Emitter<INotebookEditorMouseEvent> = this._register(new Emitter<INotebookEditorMouseEvent>());
	public readonly onMouseDown: Event<INotebookEditorMouseEvent> = this._onMouseDown.event;

	private pendingLayouts = new WeakMap<ICellViewModel, IDisposable>();

	//#endregion

	//#region Cell operations
	async layoutNotebookCell(cell: ICellViewModel, height: number): Promise<void> {
		const viewIndex = this._list!.getViewIndex(cell);
		if (viewIndex === undefined) {
			// the cell is hidden
			return;
		}

		let relayout = (cell: ICellViewModel, height: number) => {
			if (this._isDisposed) {
				return;
			}

			this._list?.updateElementHeight2(cell, height);
		};

		if (this.pendingLayouts.has(cell)) {
			this.pendingLayouts.get(cell)!.dispose();
		}

		let r: () => void;
		const layoutDisposable = DOM.scheduleAtNextAnimationFrame(() => {
			if (this._isDisposed) {
				return;
			}

			this.pendingLayouts.delete(cell);

			relayout(cell, height);
			r();
		});

		this.pendingLayouts.set(cell, toDisposable(() => {
			layoutDisposable.dispose();
			r();
		}));

		return new Promise(resolve => { r = resolve; });
	}

	insertNotebookCell(cell: ICellViewModel | undefined, type: CellKind, direction: 'above' | 'below' = 'above', initialText: string = '', ui: boolean = false): CellViewModel | null {
		if (!this._notebookViewModel!.metadata.editable) {
			return null;
		}

		const index = cell ? this._notebookViewModel!.getCellIndex(cell) : 0;
		const nextIndex = ui ? this._notebookViewModel!.getNextVisibleCellIndex(index) : index + 1;
		const newLanguages = this._notebookViewModel!.languages;
		const language = (cell?.cellKind === CellKind.Code && type === CellKind.Code)
			? cell.language
			: ((type === CellKind.Code && newLanguages && newLanguages.length) ? newLanguages[0] : 'markdown');
		const insertIndex = cell ?
			(direction === 'above' ? index : nextIndex) :
			index;
		const newCell = this._notebookViewModel!.createCell(insertIndex, initialText.split(/\r?\n/g), language, type, cell?.metadata, true);
		return newCell as CellViewModel;
	}

	async splitNotebookCell(cell: ICellViewModel): Promise<CellViewModel[] | null> {
		const index = this._notebookViewModel!.getCellIndex(cell);

		return this._notebookViewModel!.splitNotebookCell(index);
	}

	async joinNotebookCells(cell: ICellViewModel, direction: 'above' | 'below', constraint?: CellKind): Promise<ICellViewModel | null> {
		const index = this._notebookViewModel!.getCellIndex(cell);
		const ret = await this._notebookViewModel!.joinNotebookCells(index, direction, constraint);

		if (ret) {
			ret.deletedCells.forEach(cell => {
				if (this.pendingLayouts.has(cell)) {
					this.pendingLayouts.get(cell)!.dispose();
				}
			});

			return ret.cell;
		} else {
			return null;
		}
	}

	async deleteNotebookCell(cell: ICellViewModel): Promise<boolean> {
		if (!this._notebookViewModel!.metadata.editable) {
			return false;
		}

		if (this.pendingLayouts.has(cell)) {
			this.pendingLayouts.get(cell)!.dispose();
		}

		const index = this._notebookViewModel!.getCellIndex(cell);
		this._notebookViewModel!.deleteCell(index, true);
		return true;
	}

	async moveCellDown(cell: ICellViewModel): Promise<ICellViewModel | null> {
		if (!this._notebookViewModel!.metadata.editable) {
			return null;
		}

		const index = this._notebookViewModel!.getCellIndex(cell);
		if (index === this._notebookViewModel!.length - 1) {
			return null;
		}

		const newIdx = index + 1;
		return this._moveCellToIndex(index, newIdx);
	}

	async moveCellUp(cell: ICellViewModel): Promise<ICellViewModel | null> {
		if (!this._notebookViewModel!.metadata.editable) {
			return null;
		}

		const index = this._notebookViewModel!.getCellIndex(cell);
		if (index === 0) {
			return null;
		}

		const newIdx = index - 1;
		return this._moveCellToIndex(index, newIdx);
	}

	async moveCell(cell: ICellViewModel, relativeToCell: ICellViewModel, direction: 'above' | 'below'): Promise<ICellViewModel | null> {
		if (!this._notebookViewModel!.metadata.editable) {
			return null;
		}

		if (cell === relativeToCell) {
			return null;
		}

		const originalIdx = this._notebookViewModel!.getCellIndex(cell);
		const relativeToIndex = this._notebookViewModel!.getCellIndex(relativeToCell);

		let newIdx = direction === 'above' ? relativeToIndex : relativeToIndex + 1;
		if (originalIdx < newIdx) {
			newIdx--;
		}

		return this._moveCellToIndex(originalIdx, newIdx);
	}

	private async _moveCellToIndex(index: number, newIdx: number): Promise<ICellViewModel | null> {
		if (index === newIdx) {
			return null;
		}

		if (!this._notebookViewModel!.moveCellToIdx(index, newIdx, true)) {
			throw new Error('Notebook Editor move cell, index out of range');
		}

		let r: (val: ICellViewModel | null) => void;
		DOM.scheduleAtNextAnimationFrame(() => {
			if (this._isDisposed) {
				r(null);
			}

			const viewCell = this._notebookViewModel!.viewCells[newIdx];
			this._list?.revealElementInView(viewCell);
			r(viewCell);
		});

		return new Promise(resolve => { r = resolve; });
	}

	editNotebookCell(cell: CellViewModel): void {
		if (!cell.getEvaluatedMetadata(this._notebookViewModel!.metadata).editable) {
			return;
		}

		cell.editState = CellEditState.Editing;

		this._renderedEditors.get(cell)?.focus();
	}

	getActiveCell() {
		let elements = this._list?.getFocusedElements();

		if (elements && elements.length) {
			return elements[0];
		}

		return undefined;
	}

	cancelNotebookExecution(): void {
		if (!this._notebookViewModel!.currentTokenSource) {
			throw new Error('Notebook is not executing');
		}


		this._notebookViewModel!.currentTokenSource.cancel();
		this._notebookViewModel!.currentTokenSource = undefined;
	}

	async executeNotebook(): Promise<void> {
		if (!this._notebookViewModel!.metadata.runnable) {
			return;
		}

		return this._executeNotebook();
	}

	async _executeNotebook(): Promise<void> {
		if (this._notebookViewModel!.currentTokenSource) {
			return;
		}

		const tokenSource = new CancellationTokenSource();
		try {
			this._editorExecutingNotebook!.set(true);
			this._notebookViewModel!.currentTokenSource = tokenSource;
			const provider = this.notebookService.getContributedNotebookProviders(this.viewModel!.uri)[0];
			if (provider) {
				const viewType = provider.id;
				const notebookUri = this._notebookViewModel!.uri;

				if (this._activeKernel) {
					await this.notebookService.executeNotebook2(this._notebookViewModel!.viewType, this._notebookViewModel!.uri, this._activeKernel.id, tokenSource.token);
				} else if (provider.kernel) {
					return await this.notebookService.executeNotebook(viewType, notebookUri, true, tokenSource.token);
				} else {
					return await this.notebookService.executeNotebook(viewType, notebookUri, false, tokenSource.token);
				}
			}

		} finally {
			this._editorExecutingNotebook!.set(false);
			this._notebookViewModel!.currentTokenSource = undefined;
			tokenSource.dispose();
		}
	}

	cancelNotebookCellExecution(cell: ICellViewModel): void {
		if (!cell.currentTokenSource) {
			throw new Error('Cell is not executing');
		}

		cell.currentTokenSource.cancel();
		cell.currentTokenSource = undefined;
	}

	async executeNotebookCell(cell: ICellViewModel): Promise<void> {
		if (cell.cellKind === CellKind.Markdown) {
			this.focusNotebookCell(cell, 'container');
			return;
		}

		if (!cell.getEvaluatedMetadata(this._notebookViewModel!.metadata).runnable) {
			return;
		}

		const tokenSource = new CancellationTokenSource();
		try {
			await this._executeNotebookCell(cell, tokenSource);
		} finally {
			tokenSource.dispose();
		}
	}

	private async _executeNotebookCell(cell: ICellViewModel, tokenSource: CancellationTokenSource): Promise<void> {
		try {
			cell.currentTokenSource = tokenSource;

			const provider = this.notebookService.getContributedNotebookProviders(this.viewModel!.uri)[0];
			if (provider) {
				const viewType = provider.id;
				const notebookUri = this._notebookViewModel!.uri;

				if (this._activeKernel) {
					return await this.notebookService.executeNotebookCell2(viewType, notebookUri, cell.handle, this._activeKernel.id, tokenSource.token);
				} else if (provider.kernel) {
					return await this.notebookService.executeNotebookCell(viewType, notebookUri, cell.handle, true, tokenSource.token);
				} else {
					return await this.notebookService.executeNotebookCell(viewType, notebookUri, cell.handle, false, tokenSource.token);
				}
			}
		} finally {
			cell.currentTokenSource = undefined;
		}
	}

	focusNotebookCell(cell: ICellViewModel, focusItem: 'editor' | 'container' | 'output') {
		if (this._isDisposed) {
			return;
		}

		if (focusItem === 'editor') {
			this.selectElement(cell);
			this._list?.focusView();

			cell.editState = CellEditState.Editing;
			cell.focusMode = CellFocusMode.Editor;
			this.revealInCenterIfOutsideViewport(cell);
		} else if (focusItem === 'output') {
			this.selectElement(cell);
			this._list?.focusView();

			if (!this._webview) {
				return;
			}
			this._webview.focusOutput(cell.id);

			cell.editState = CellEditState.Preview;
			cell.focusMode = CellFocusMode.Container;
			this.revealInCenterIfOutsideViewport(cell);
		} else {
			let itemDOM = this._list?.domElementOfElement(cell);
			if (document.activeElement && itemDOM && itemDOM.contains(document.activeElement)) {
				(document.activeElement as HTMLElement).blur();
			}

			cell.editState = CellEditState.Preview;
			cell.focusMode = CellFocusMode.Container;

			this.selectElement(cell);
			this.revealInCenterIfOutsideViewport(cell);
			this._list?.focusView();
		}
	}

	//#endregion

	//#region MISC

	getLayoutInfo(): NotebookLayoutInfo {
		if (!this._list) {
			throw new Error('Editor is not initalized successfully');
		}

		return {
			width: this._dimension!.width,
			height: this._dimension!.height,
			fontInfo: this._fontInfo!
		};
	}

	triggerScroll(event: IMouseWheelEvent) {
		this._list?.triggerScrollFromMouseWheelEvent(event);
	}

	createInset(cell: CodeCellViewModel, output: IProcessedOutput, shadowContent: string, offset: number) {
		if (!this._webview) {
			return;
		}

		let preloads = this._notebookViewModel!.renderers;

		if (!this._webview!.insetMapping.has(output)) {
			let cellTop = this._list?.getAbsoluteTopOfElement(cell) || 0;
			this._webview!.createInset(cell, output, cellTop, offset, shadowContent, preloads);
		} else {
			let cellTop = this._list?.getAbsoluteTopOfElement(cell) || 0;
			let scrollTop = this._list?.scrollTop || 0;

			this._webview!.updateViewScrollTop(-scrollTop, [{ cell: cell, output: output, cellTop: cellTop }]);
		}
	}

	removeInset(output: IProcessedOutput) {
		if (!this._webview) {
			return;
		}

		this._webview!.removeInset(output);
	}

	hideInset(output: IProcessedOutput) {
		if (!this._webview) {
			return;
		}

		this._webview!.hideInset(output);
	}

	getOutputRenderer(): OutputRenderer {
		return this._outputRenderer;
	}

	postMessage(forRendererId: string | undefined, message: any) {
		if (forRendererId === undefined) {
			this._webview?.webview.postMessage(message);
		} else {
			this._webview?.postRendererMessage(forRendererId, message);
		}
	}

	toggleClassName(className: string) {
		DOM.toggleClass(this._overlayContainer, className);
	}

	addClassName(className: string) {
		DOM.addClass(this._overlayContainer, className);
	}

	removeClassName(className: string) {
		DOM.removeClass(this._overlayContainer, className);
	}


	//#endregion

	//#region Editor Contributions
	public getContribution<T extends INotebookEditorContribution>(id: string): T {
		return <T>(this._contributions[id] || null);
	}

	//#endregion

	dispose() {
		this._isDisposed = true;
		// dispose webview first
		this._webview?.dispose();

		this.notebookService.removeNotebookEditor(this);
		const keys = Object.keys(this._contributions);
		for (let i = 0, len = keys.length; i < len; i++) {
			const contributionId = keys[i];
			this._contributions[contributionId].dispose();
		}

		this._localStore.clear();
		this._list?.dispose();

		this._overlayContainer.remove();
		this.viewModel?.dispose();

		// this._layoutService.container.removeChild(this.overlayContainer);

		super.dispose();
	}

	toJSON(): object {
		return {
			notebookHandle: this.viewModel?.handle
		};
	}
}

export const notebookCellBorder = registerColor('notebook.cellBorderColor', {
	dark: transparent(PANEL_BORDER, .4),
	light: transparent(PANEL_BORDER, .3),
	hc: PANEL_BORDER
}, nls.localize('notebook.cellBorderColor', "The border color for notebook cells."));

export const focusedEditorIndicator = registerColor('notebook.focusedEditorIndicator', {
	light: focusBorder,
	dark: focusBorder,
	hc: focusBorder
}, nls.localize('notebook.focusedEditorIndicator', "The color of the notebook cell editor indicator."));

export const cellStatusIconSuccess = registerColor('notebookStatusSuccessIcon.foreground', {
	light: debugIconStartForeground,
	dark: debugIconStartForeground,
	hc: debugIconStartForeground
}, nls.localize('notebookStatusSuccessIcon.foreground', "The error icon color of notebook cells in the cell status bar."));

export const cellStatusIconError = registerColor('notebookStatusErrorIcon.foreground', {
	light: errorForeground,
	dark: errorForeground,
	hc: errorForeground
}, nls.localize('notebookStatusErrorIcon.foreground', "The error icon color of notebook cells in the cell status bar."));

export const cellStatusIconRunning = registerColor('notebookStatusRunningIcon.foreground', {
	light: foreground,
	dark: foreground,
	hc: foreground
}, nls.localize('notebookStatusRunningIcon.foreground', "The running icon color of notebook cells in the cell status bar."));

export const notebookOutputContainerColor = registerColor('notebook.outputContainerBackgroundColor', {
	dark: notebookCellBorder,
	light: notebookCellBorder,
	hc: null
}, nls.localize('notebook.outputContainerBackgroundColor', "The Color of the notebook output container background."));

// TODO currently also used for toolbar border, if we keep all of this, pick a generic name
export const CELL_TOOLBAR_SEPERATOR = registerColor('notebook.cellToolbarSeperator', {
	dark: Color.fromHex('#808080').transparent(0.35),
	light: Color.fromHex('#808080').transparent(0.35),
	hc: contrastBorder
}, nls.localize('cellToolbarSeperator', "The color of the seperator in the cell bottom toolbar"));

export const cellFocusBackground = registerColor('notebook.cellFocusBackground', {
	dark: transparent(PANEL_BORDER, .4),
	light: transparent(PANEL_BORDER, .3),
	hc: PANEL_BORDER
}, nls.localize('cellFocusBackground', "The background color of focused or hovered cells"));

export const focusedCellShadow = registerColor('notebook.focusedCellShadow', {
	dark: Color.black.transparent(0.6),
	light: Color.black.transparent(0.04),
	hc: Color.transparent
}, nls.localize('cellShadow', "The color of the shadow on the focused or hovered cell"));

export const cellStatusBarItemHover = registerColor('notebook.cellStatusBarItemHoverBackground', {
	light: new Color(new RGBA(0, 0, 0, 0.08)),
	dark: new Color(new RGBA(255, 255, 255, 0.15)),
	hc: new Color(new RGBA(255, 255, 255, 0.15)),
}, nls.localize('notebook.cellStatusBarItemHoverBackground', "The background color of notebook cell status bar items."));

export const cellInsertionIndicator = registerColor('notebook.cellInsertionIndicator', {
	light: focusBorder,
	dark: focusBorder,
	hc: focusBorder
}, nls.localize('notebook.cellInsertionIndicator', "The color of the notebook cell insertion indicator."));


export const listScrollbarSliderBackground = registerColor('notebookScrollbarSlider.background', {
	dark: Color.fromHex('#797979').transparent(0.4),
	light: Color.fromHex('#646464').transparent(0.4),
	hc: transparent(contrastBorder, 0.6)
}, nls.localize('notebookScrollbarSliderBackground', "Notebook scrollbar slider background color."));

export const listScrollbarSliderHoverBackground = registerColor('notebookScrollbarSlider.hoverBackground', {
	dark: Color.fromHex('#646464').transparent(0.7),
	light: Color.fromHex('#646464').transparent(0.7),
	hc: transparent(contrastBorder, 0.8)
}, nls.localize('notebookScrollbarSliderHoverBackground', "Notebook scrollbar slider background color when hovering."));

export const listScrollbarSliderActiveBackground = registerColor('notebookScrollbarSlider.activeBackground', {
	dark: Color.fromHex('#BFBFBF').transparent(0.4),
	light: Color.fromHex('#000000').transparent(0.6),
	hc: contrastBorder
}, nls.localize('notebookScrollbarSliderActiveBackground', "Notebook scrollbar slider background color when clicked on."));



registerThemingParticipant((theme, collector) => {
	collector.addRule(`.notebookOverlay > .cell-list-container > .monaco-list > .monaco-scrollable-element {
		padding-top: ${SCROLLABLE_ELEMENT_PADDING_TOP}px;
		box-sizing: border-box;
	}`);

	// const color = getExtraColor(theme, embeddedEditorBackground, { dark: 'rgba(0, 0, 0, .4)', extra_dark: 'rgba(200, 235, 255, .064)', light: '#f4f4f4', hc: null });
	const color = theme.getColor(editorBackground);
	if (color) {
		collector.addRule(`.notebookOverlay .cell .monaco-editor-background,
			.notebookOverlay .cell .margin-view-overlays,
			.notebookOverlay .cell .cell-statusbar-container { background: ${color}; }`);
		collector.addRule(`.notebookOverlay .cell-drag-image .cell-editor-container > div { background: ${color} !important; }`);
	}
	const link = theme.getColor(textLinkForeground);
	if (link) {
		collector.addRule(`.notebookOverlay .output a,
			.notebookOverlay .cell.markdown a { color: ${link};} `);
	}
	const activeLink = theme.getColor(textLinkActiveForeground);
	if (activeLink) {
		collector.addRule(`.notebookOverlay .output a:hover,
			.notebookOverlay .cell .output a:active { color: ${activeLink}; }`);
	}
	const shortcut = theme.getColor(textPreformatForeground);
	if (shortcut) {
		collector.addRule(`.notebookOverlay code,
			.notebookOverlay .shortcut { color: ${shortcut}; }`);
	}
	const border = theme.getColor(contrastBorder);
	if (border) {
		collector.addRule(`.notebookOverlay .monaco-editor { border-color: ${border}; }`);
	}
	const quoteBackground = theme.getColor(textBlockQuoteBackground);
	if (quoteBackground) {
		collector.addRule(`.notebookOverlay blockquote { background: ${quoteBackground}; }`);
	}
	const quoteBorder = theme.getColor(textBlockQuoteBorder);
	if (quoteBorder) {
		collector.addRule(`.notebookOverlay blockquote { border-color: ${quoteBorder}; }`);
	}

	const containerBackground = theme.getColor(notebookOutputContainerColor);
	if (containerBackground) {
		collector.addRule(`.notebookOverlay .output { background-color: ${containerBackground}; }`);
		collector.addRule(`.notebookOverlay .output-element { background-color: ${containerBackground}; }`);
	}

	const editorBackgroundColor = theme.getColor(editorBackground);
	if (editorBackgroundColor) {
		collector.addRule(`.notebookOverlay .cell-statusbar-container { border-top: solid 1px ${editorBackgroundColor}; }`);
		collector.addRule(`.notebookOverlay .monaco-list-row > .monaco-toolbar { background-color: ${editorBackgroundColor}; }`);
		collector.addRule(`.notebookOverlay .monaco-list-row.cell-drag-image { background-color: ${editorBackgroundColor}; }`);
	}

	const cellToolbarSeperator = theme.getColor(CELL_TOOLBAR_SEPERATOR);
	if (cellToolbarSeperator) {
		collector.addRule(`.notebookOverlay .cell-bottom-toolbar-container .separator { background-color: ${cellToolbarSeperator} }`);
		collector.addRule(`.notebookOverlay .cell-bottom-toolbar-container .action-item:first-child::after { background-color: ${cellToolbarSeperator} }`);
		collector.addRule(`.notebookOverlay .monaco-list-row > .monaco-toolbar { border: solid 1px ${cellToolbarSeperator}; }`);
	}

	const cellFocusBackgroundColor = theme.getColor(cellFocusBackground);
	if (cellFocusBackgroundColor) {
		collector.addRule(`.notebookOverlay .code-cell-row:hover .cell-focus-indicator,
			.notebookOverlay .code-cell-row.focused .cell-focus-indicator,
			.notebookOverlay .code-cell-row.cell-output-hover .cell-focus-indicator { background-color: ${cellFocusBackgroundColor} !important; }`);
		collector.addRule(`.notebookOverlay .markdown-cell-row:hover,
			.notebookOverlay .markdown-cell-row.focused { background-color: ${cellFocusBackgroundColor} !important; }`);
	}

	const focusedEditorIndicatorColor = theme.getColor(focusedEditorIndicator);
	if (focusedEditorIndicatorColor) {
		collector.addRule(`.notebookOverlay .monaco-list-row.cell-editor-focus .cell-editor-part:before { outline: solid 1px ${focusedEditorIndicatorColor}; }`);
	}

	const editorBorderColor = theme.getColor(notebookCellBorder);
	if (editorBorderColor) {
		collector.addRule(`.notebookOverlay .monaco-list-row .cell-editor-part:before { outline: solid 1px ${editorBorderColor}; }`);
	}

	const headingBorderColor = theme.getColor(notebookCellBorder);
	if (headingBorderColor) {
		collector.addRule(`.notebookOverlay .cell.markdown h1 { border-color: ${headingBorderColor}; }`);
	}

	const cellStatusSuccessIcon = theme.getColor(cellStatusIconSuccess);
	if (cellStatusSuccessIcon) {
		collector.addRule(`.monaco-workbench .notebookOverlay .cell-statusbar-container .cell-run-status .codicon-check { color: ${cellStatusSuccessIcon} }`);
	}

	const cellStatusErrorIcon = theme.getColor(cellStatusIconError);
	if (cellStatusErrorIcon) {
		collector.addRule(`.monaco-workbench .notebookOverlay .cell-statusbar-container .cell-run-status .codicon-error { color: ${cellStatusErrorIcon} }`);
	}

	const cellStatusRunningIcon = theme.getColor(cellStatusIconRunning);
	if (cellStatusRunningIcon) {
		collector.addRule(`.monaco-workbench .notebookOverlay .cell-statusbar-container .cell-run-status .codicon-sync { color: ${cellStatusRunningIcon} }`);
	}

	const cellStatusBarHoverBg = theme.getColor(cellStatusBarItemHover);
	if (cellStatusBarHoverBg) {
		collector.addRule(`.monaco-workbench .notebookOverlay .cell-statusbar-container .cell-language-picker:hover { background-color: ${cellStatusBarHoverBg}; }`);
	}

	const cellShadowColor = theme.getColor(focusedCellShadow);
	if (cellShadowColor) {
		// Code cells
		collector.addRule(`.monaco-workbench .notebookOverlay .monaco-list .monaco-list-row.focused .cell-shadow { box-shadow: 0px 1px 4px 2px ${cellShadowColor} }`);

		// Markdown cells
		collector.addRule(`.monaco-workbench .notebookOverlay .monaco-list .markdown-cell-row.focused { box-shadow: 0px 1px 4px 2px ${cellShadowColor} }`);
	}

	const cellInsertionIndicatorColor = theme.getColor(cellInsertionIndicator);
	if (cellInsertionIndicatorColor) {
		collector.addRule(`.notebookOverlay > .cell-list-container > .cell-list-insertion-indicator { background-color: ${cellInsertionIndicatorColor}; }`);
	}

	const scrollbarSliderBackgroundColor = theme.getColor(listScrollbarSliderBackground);
	if (scrollbarSliderBackgroundColor) {
		collector.addRule(` .notebookOverlay .cell-list-container > .monaco-list > .monaco-scrollable-element > .scrollbar > .slider { background: ${scrollbarSliderBackgroundColor}; } `);
	}

	const scrollbarSliderHoverBackgroundColor = theme.getColor(listScrollbarSliderHoverBackground);
	if (scrollbarSliderHoverBackgroundColor) {
		collector.addRule(` .notebookOverlay .cell-list-container > .monaco-list > .monaco-scrollable-element > .scrollbar > .slider:hover { background: ${scrollbarSliderHoverBackgroundColor}; } `);
	}

	const scrollbarSliderActiveBackgroundColor = theme.getColor(listScrollbarSliderActiveBackground);
	if (scrollbarSliderActiveBackgroundColor) {
		collector.addRule(` .notebookOverlay .cell-list-container > .monaco-list > .monaco-scrollable-element > .scrollbar > .slider.active { background: ${scrollbarSliderActiveBackgroundColor}; } `);
	}

	// Cell Margin
	collector.addRule(`.notebookOverlay .cell-list-container > .monaco-list > .monaco-scrollable-element > .monaco-list-rows > .monaco-list-row  > div.cell { margin: 0px ${CELL_MARGIN}px 0px ${CELL_MARGIN}px; }`);
	collector.addRule(`.notebookOverlay .cell-list-container > .monaco-list > .monaco-scrollable-element > .monaco-list-rows > .monaco-list-row  > div.cell.code { margin-left: ${CODE_CELL_LEFT_MARGIN}px; }`);
	collector.addRule(`.notebookOverlay .cell-list-container > .monaco-list > .monaco-scrollable-element > .monaco-list-rows > .monaco-list-row { padding-top: ${EDITOR_TOP_MARGIN}px; }`);
	collector.addRule(`.notebookOverlay .cell-list-container > .monaco-list > .monaco-scrollable-element > .monaco-list-rows > .markdown-cell-row { padding-bottom: ${CELL_BOTTOM_MARGIN}px; }`);
	collector.addRule(`.notebookOverlay .cell-list-container > .monaco-list > .monaco-scrollable-element > .monaco-list-rows > .markdown-cell-row .cell-bottom-toolbar-container { margin-top: ${CELL_BOTTOM_MARGIN}px; }`);
	collector.addRule(`.notebookOverlay .output { margin: 0px ${CELL_MARGIN}px 0px ${CODE_CELL_LEFT_MARGIN + CELL_RUN_GUTTER}px; }`);
	collector.addRule(`.notebookOverlay .output { width: calc(100% - ${CODE_CELL_LEFT_MARGIN + CELL_RUN_GUTTER + CELL_MARGIN}px); }`);
	collector.addRule(`.notebookOverlay .cell-bottom-toolbar-container { width: calc(100% - ${CELL_MARGIN * 2 + CELL_RUN_GUTTER}px); margin: 0px ${CELL_MARGIN}px 0px ${CELL_MARGIN + CELL_RUN_GUTTER}px; }`);

	collector.addRule(`.notebookOverlay .markdown-cell-row .cell .cell-editor-part { margin-left: ${CELL_RUN_GUTTER}px; }`);
	collector.addRule(`.notebookOverlay .cell-list-container > .monaco-list > .monaco-scrollable-element > .monaco-list-rows > .monaco-list-row  > div.cell.markdown { padding-left: ${CELL_RUN_GUTTER}px; }`);
	collector.addRule(`.notebookOverlay .cell .run-button-container { width: ${CELL_RUN_GUTTER}px; }`);
	collector.addRule(`.notebookOverlay .cell-drag-image .cell-editor-container > div { padding: ${EDITOR_TOP_PADDING}px 16px ${EDITOR_BOTTOM_PADDING}px 16px; }`);
	collector.addRule(`.notebookOverlay .monaco-list .monaco-list-row .cell-focus-indicator-top { height: ${EDITOR_TOP_MARGIN}px; }`);
	collector.addRule(`.notebookOverlay .monaco-list .monaco-list-row .cell-focus-indicator-side { bottom: ${BOTTOM_CELL_TOOLBAR_HEIGHT}px; }`);
	collector.addRule(`.notebookOverlay .monaco-list .monaco-list-row .cell-focus-indicator { width: ${CODE_CELL_LEFT_MARGIN + CELL_RUN_GUTTER}px; }`);
	collector.addRule(`.notebookOverlay .monaco-list .monaco-list-row .cell-focus-indicator.cell-focus-indicator-right { width: ${CELL_MARGIN}px; }`);
	collector.addRule(`.notebookOverlay .monaco-list .monaco-list-row .cell-focus-indicator-bottom { height: ${CELL_BOTTOM_MARGIN}px; }`);
	collector.addRule(`.notebookOverlay .monaco-list .monaco-list-row .cell-shadow-container-bottom { top: ${CELL_BOTTOM_MARGIN}px; }`);
});
