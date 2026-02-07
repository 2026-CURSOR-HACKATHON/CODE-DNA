import * as vscode from 'vscode';
import { MetadataStore } from '../store/metadataStore';

/**
 * AI Context가 있는 라인에 시각적 표시를 추가하는 Decorator
 */
export class AIContextDecorator {
  private decorationType: vscode.TextEditorDecorationType;
  private disposables: vscode.Disposable[] = [];

  constructor(private metadataStore: MetadataStore) {
    // Gutter 아이콘과 라인 하이라이트 스타일 정의
    this.decorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: this.createGutterIcon(),
      gutterIconSize: 'contain',
      isWholeLine: true,
      borderWidth: '0 0 0 2px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('editorInfo.foreground'),
      overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    // 활성 에디터 변경 시 데코레이션 업데이트
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.updateDecorations(editor);
        }
      })
    );

    // 텍스트 변경 시 데코레이션 업데이트
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && event.document === editor.document) {
          this.updateDecorations(editor);
        }
      })
    );

    // 초기 데코레이션 적용
    if (vscode.window.activeTextEditor) {
      this.updateDecorations(vscode.window.activeTextEditor);
    }
  }

  private createGutterIcon(): vscode.Uri {
    // SVG 아이콘을 data URI로 생성
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6" fill="none" stroke="#4FC3F7" stroke-width="2"/>
      <circle cx="8" cy="8" r="3" fill="#4FC3F7"/>
    </svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  }

  private updateDecorations(editor: vscode.TextEditor): void {
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
    const decorations: vscode.DecorationOptions[] = [];

    // 파일의 모든 라인을 확인하여 AI Context가 있는 라인 찾기
    for (let lineNum = 1; lineNum <= editor.document.lineCount; lineNum++) {
      const metadataEntries = this.metadataStore.getMetadataByFileAndLine(relativePath, lineNum);
      const contextEntries = this.metadataStore.getContextsForFileAndLine(relativePath, lineNum);

      if (metadataEntries.length > 0 || contextEntries.length > 0) {
        const range = new vscode.Range(
          new vscode.Position(lineNum - 1, 0),
          new vscode.Position(lineNum - 1, 0)
        );

        decorations.push({
          range,
        });
      }
    }

    editor.setDecorations(this.decorationType, decorations);
  }

  public refresh(): void {
    if (vscode.window.activeTextEditor) {
      this.updateDecorations(vscode.window.activeTextEditor);
    }
  }

  public dispose(): void {
    this.decorationType.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
