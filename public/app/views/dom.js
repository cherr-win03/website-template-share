// DOM 만들기 도우미. 글자는 언제나 textContent / 텍스트 노드로만 넣는다(HTML 로 해석하지 않는다).
export function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (name === 'text') node.textContent = String(value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
