// A source file and its line table.

export class SourceFile {
  constructor(name, text) {
    this.name = name;
    this.text = text;
    // lineStarts[i] is the offset of the first code unit of line i + 1.
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x0a || (c === 0x0d && text.charCodeAt(i + 1) !== 0x0a)) {
        this.lineStarts.push(i + 1);
      }
    }
  }

  get lineCount() {
    return this.lineStarts.length;
  }

  // The text of a 1-based line, without its terminator.
  lineText(line) {
    const start = this.lineStarts[line - 1];
    if (start === undefined) return '';
    const end = line < this.lineStarts.length ? this.lineStarts[line] : this.text.length;
    return this.text.slice(start, end).replace(/\r?\n$|\r$/, '');
  }
}
