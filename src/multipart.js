/**
 * 极简 multipart/form-data 解析（零依赖，只给 Express 这条线用）。
 * Workers 运行时自带 request.formData()，不需要这个。
 *
 * 做法：整段 body 按 latin1 转成字符串（latin1 与字节 1:1，不会破坏 UTF-8），
 * 按边界切段、取每段的头与体，再把体按 latin1 还原成字节、按 UTF-8 解码。
 * 只支持文本字段与文件字段，够投稿表单用；不做流式解析。
 */

/** @returns {{fields:Object<string,string>, files:Object<string,{name:string,type:string,size:number,html:string}>}} */
export function parseMultipart(buffer, contentType) {
  const empty = { fields: {}, files: {} };
  const m = /boundary=(?:"([^"]*)"|([^;]*))/i.exec(String(contentType || ''));
  if (!m) return empty;
  const boundary = String(m[1] || m[2] || '').trim();
  if (!boundary) return empty;

  const raw = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : Buffer.from(buffer || '').toString('latin1');
  const segs = raw.split('--' + boundary);
  const fields = {};
  const files = {};

  for (let i = 1; i < segs.length; i++) {
    let seg = segs[i];
    if (seg.slice(0, 2) === '--') break; // 结束边界
    if (seg.slice(0, 2) === '\r\n') seg = seg.slice(2);
    const at = seg.indexOf('\r\n\r\n');
    if (at < 0) continue;
    const head = seg.slice(0, at);
    let body = seg.slice(at + 4);
    if (body.slice(-2) === '\r\n') body = body.slice(0, -2);

    const nameM = /name="([^"]*)"/i.exec(head);
    if (!nameM) continue;
    const text = Buffer.from(body, 'latin1').toString('utf8');
    const fileM = /filename="([^"]*)"/i.exec(head);
    if (fileM) {
      const typeM = /content-type:\s*([^\r\n]+)/i.exec(head);
      files[nameM[1]] = {
        name: fileM[1],
        type: typeM ? typeM[1].trim() : '',
        size: Buffer.byteLength(text, 'utf8'),
        html: text
      };
    } else {
      fields[nameM[1]] = text;
    }
  }
  return { fields: fields, files: files };
}

/** 把 multipart 解析结果摊平成 createSubmission() 认识的那个对象 */
export function formFromMultipart(buffer, contentType, fileField) {
  const p = parseMultipart(buffer, contentType);
  const out = Object.assign({}, p.fields);
  const file = p.files[fileField || 'game_file'] || p.files['file'];
  if (file) out.file = file;
  return out;
}
