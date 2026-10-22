/**
 * 零依赖响应压缩中间件（brotli / gzip / deflate）。
 *
 * 为什么不用 compression 包：本站的卖点之一是「只有一个运行时依赖 express」，
 * 为了一段 40 行的逻辑把整棵依赖树引进来不划算。这里直接吃 node:zlib。
 *
 * 工作方式：把响应体先缓冲下来（本站最大响应是回放导出，几百 KB 量级，无所谓），
 * 在 res.end 时决定要不要压。这样做能同时覆盖 Express 的 res.send 与
 * express.static 的流式发送——只包 res.send 的话，最该压的 CSS / JS 反而漏掉。
 *
 * 不压的情况（任何一条命中就直接原样输出）：
 *   - 请求带 Range（分片下载）、方法是 HEAD；
 *   - 响应已经有 Content-Encoding（比如 /replays/export 自己吐的 .gz）；
 *   - 状态码 204 / 304；
 *   - Cache-Control 里写了 no-transform；
 *   - Content-Type 不是文本类；
 *   - 体积小于 1 KB（压缩后反而更大，而且会白占一个 Vary 缓存键）。
 *
 * 压缩后重写 Content-Length 并补 Vary: Accept-Encoding；ETag 保持不动
 * （Express 默认弱 ETag，按 RFC 7232 弱比较允许跨编码复用）。
 */
import zlib from 'node:zlib';

const MIN_BYTES = 1024;

/** 值得压缩的 MIME 前缀。图片/字体/压缩包本身已压缩，压了不划算。 */
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|xml|javascript|ecmascript|manifest\+json|x-www-form-urlencoded)|image\/svg\+xml)/i;

const TOKEN = {
  br: /(?:^|,)\s*br\s*(?:;|,|$)/i,
  gzip: /(?:^|,)\s*gzip\s*(?:;|,|$)/i,
  deflate: /(?:^|,)\s*deflate\s*(?:;|,|$)/i
};

/**
 * 按 Accept-Encoding 选一种编码，优先级 br > gzip > deflate。
 * 只认 q=0 以外的写法；q 值细节（q=0 表示拒绝）这里按常见实现处理：
 * 明确写 q=0 的跳过。
 */
export function pickEncoding(header) {
  const raw = String(header || '');
  if (!raw) return '';
  const parts = raw.split(',').map((s) => s.trim().toLowerCase());
  const denied = new Set(
    parts
      .filter((s) => /;q=0(?:\.0+)?$/.test(s))
      .map((s) => s.split(';')[0].trim())
  );
  for (const enc of ['br', 'gzip', 'deflate']) {
    if (TOKEN[enc].test(raw) && !denied.has(enc) && !denied.has('*')) return enc;
  }
  return '';
}

function compressor(enc) {
  if (enc === 'br') {
    return (buf, cb) =>
      zlib.brotliCompress(
        buf,
        {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length
          }
        },
        cb
      );
  }
  if (enc === 'deflate') return (buf, cb) => zlib.deflate(buf, { level: 6 }, cb);
  return (buf, cb) => zlib.gzip(buf, { level: 6 }, cb);
}

export function compress({ minBytes = MIN_BYTES } = {}) {
  return function compressMiddleware(req, res, next) {
    if (req.method === 'HEAD' || req.headers.range) return next();
    const enc = pickEncoding(req.headers['accept-encoding']);
    if (!enc) return next();

    const chunks = [];
    let total = 0;
    let finished = false;

    const write = res.write;
    const end = res.end;

    res.write = function (chunk, encoding) {
      if (finished) return write.call(this, chunk, encoding);
      if (chunk == null) return true;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
      chunks.push(buf);
      total += buf.length;
      return true;
    };

    res.end = function (chunk, encoding) {
      if (finished) return end.call(this, chunk, encoding);
      finished = true;
      if (chunk != null) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
        chunks.push(buf);
        total += buf.length;
      }
      const body = total === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total);

      const bail = () => end.call(res, body);
      if (body.length < minBytes) return bail();
      if (res.getHeader('Content-Encoding')) return bail();
      if (res.statusCode === 204 || res.statusCode === 304 || res.statusCode < 200) return bail();
      const cacheControl = String(res.getHeader('Cache-Control') || '');
      if (cacheControl.includes('no-transform')) return bail();
      const type = String(res.getHeader('Content-Type') || '');
      if (!type || !COMPRESSIBLE.test(type)) return bail();

      compressor(enc)(body, (err, out) => {
        if (err || !out || out.length >= body.length) return bail();
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Content-Encoding', enc);
        res.setHeader('Content-Length', String(out.length));
        end.call(res, out);
      });
    };

    next();
  };
}

export default compress;
