// server.js
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const ftp = require('basic-ftp');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   Configurações e Helpers
   ========================= */
const upload = multer({ dest: 'uploads/' });

// Caminhos do "banco" no FTP e arquivo temporário local
const REMOTE_DB = process.env.REMOTE_DB || 'imoveis/dados.json';
const TMP_DB = process.env.TMP_DB || path.join(__dirname, 'dados.tmp.json');

// Cliente FTP
async function getFtpClient() {
  const client = new ftp.Client();
  await client.access({
    host: process.env.FTP_HOST,
    user: process.env.FTP_USER,
    password: process.env.FTP_PASS,
    secure: false,
  });
  return client;
}

// Lê o DB do FTP
async function readDb() {
  let client;
  try {
    client = await getFtpClient();

    // Tenta baixar o arquivo; se não existir, retorna []
    try {
      await client.downloadTo(TMP_DB, REMOTE_DB);
      const raw = fs.readFileSync(TMP_DB, 'utf8');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  } catch (e) {
    console.error('Erro ao ler DB do FTP:', e);
    return [];
  } finally {
    if (client) client.close();
    try { fs.unlinkSync(TMP_DB); } catch {}
  }
}

// Escreve o DB no FTP (upload de arquivo temporário)
async function writeDb(db) {
  let client;
  try {
    fs.writeFileSync(TMP_DB, JSON.stringify(db, null, 2), 'utf8');
    client = await getFtpClient();

    // (opcional) escrever de forma segura: sobe como .tmp e renomeia
    const remoteTmp = `${REMOTE_DB}.tmp`;
    await client.uploadFrom(TMP_DB, remoteTmp);
    try {
      // tenta apagar o antigo; se não existir, ignora
      await client.remove(REMOTE_DB);
    } catch {}
    await client.rename(remoteTmp, REMOTE_DB);
  } catch (e) {
    console.error('Erro ao escrever DB no FTP:', e);
    throw e;
  } finally {
    if (client) client.close();
    try { fs.unlinkSync(TMP_DB); } catch {}
  }
}

// Util para parse de details
const parseDetails = (details) => {
  if (details === undefined) return undefined;
  if (typeof details !== 'string') return details;
  try { return JSON.parse(details); } catch { return details; }
};

/* =========================
   Rotas
   ========================= */

// Healthcheck
app.get('/health', (_req, res) => res.send('ok'));

// LISTAR
app.get('/api/imoveis', async (_req, res) => {
  const db = await readDb();
  res.json(db);
});

// CADASTRAR (POST)
app.post('/api/upload-imovel', upload.array('images'), async (req, res) => {
  const { kind, type, title, location, price, area, dorm, parking, bath, details } = req.body;
  const files = req.files || [];

  let client;
  try {
    let db = await readDb();
    const newId = db.length > 0 ? Math.max(...db.map(i => i.id)) + 1 : 1;

    client = await getFtpClient();

    // sobe imagens {id}img{ordem}{ext}
    const uploadedImages = [];
    let ordem = 1;
    for (const file of files) {
      const ext = path.extname(file.originalname).toLowerCase();
      const ftpFilename = `${newId}img${ordem}${ext}`;
      await client.uploadFrom(file.path, `imoveis/${ftpFilename}`);
      uploadedImages.push(ftpFilename);
      ordem++;
    }

    const newImovel = {
      id: newId,
      kind,
      type,
      title,
      location,
      price,
      area,
      dorm,
      parking,
      bath,
      details: parseDetails(details) ?? [],
      images: uploadedImages,
    };

    db.push(newImovel);
    await writeDb(db);

    res.json({ message: 'Imóvel salvo com sucesso!', id: newId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao salvar imóvel' });
  } finally {
    // limpa temporários
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch {}
    }
    if (client) client.close();
  }
});

// EDITAR (PUT) — troca imagens se enviar novas
app.put('/api/imoveis/:id', upload.array('images'), async (req, res) => {
  const id = Number(req.params.id);
  const { kind, type, title, location, price, area, dorm, parking, bath } = req.body;
  const files = req.files || [];

  let client;
  try {
    const db = await readDb();
    const idx = db.findIndex(i => i.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Imóvel não encontrado' });

    const current = db[idx];

    // Atualiza campos textuais
    db[idx] = {
      ...current,
      ...(kind !== undefined ? { kind } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(price !== undefined ? { price } : {}),
      ...(area !== undefined ? { area } : {}),
      ...(dorm !== undefined ? { dorm } : {}),
      ...(parking !== undefined ? { parking } : {}),
      ...(bath !== undefined ? { bath } : {}),
      ...(req.body.details !== undefined ? { details: parseDetails(req.body.details) } : {}),
    };

    if (files.length > 0) {
      client = await getFtpClient();

      // remove antigas (ignora erro)
      if (Array.isArray(current.images)) {
        for (const img of current.images) {
          try { await client.remove(`imoveis/${img}`); }
          catch (e) { console.warn('Falha ao remover no FTP:', img, e?.message); }
        }
      }

      // sobe novas {id}img{ordem}{ext}
      const uploadedImages = [];
      let ordem = 1;
      for (const file of files) {
        const ext = path.extname(file.originalname).toLowerCase();
        const ftpFilename = `${id}img${ordem}${ext}`;
        await client.uploadFrom(file.path, `imoveis/${ftpFilename}`);
        uploadedImages.push(ftpFilename);
        ordem++;
      }

      db[idx].images = uploadedImages;
    }

    await writeDb(db);
    res.json(db[idx]);
  } catch (e) {
    console.error('Erro ao editar:', e);
    res.status(500).json({ error: 'Erro ao editar imóvel' });
  } finally {
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch {}
    }
    if (client) client.close();
  }
});

// EXCLUIR (DELETE)
app.delete('/api/imoveis/:id', async (req, res) => {
  const id = Number(req.params.id);

  let client;
  try {
    const db = await readDb();
    const idx = db.findIndex(i => i.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Imóvel não encontrado' });

    const item = db[idx];

    try {
      client = await getFtpClient();
      if (Array.isArray(item.images)) {
        for (const img of item.images) {
          try { await client.remove(`imoveis/${img}`); }
          catch (e) { console.warn('Falha ao remover no FTP:', img, e?.message); }
        }
      }
    } catch (e) {
      console.warn('Não foi possível apagar imagens no FTP. Continuando exclusão do JSON.');
    } finally {
      if (client) client.close();
    }

    db.splice(idx, 1);
    await writeDb(db);
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro no delete:', e);
    res.status(500).json({ error: 'Erro ao excluir imóvel' });
  }
});

// Lista conteúdo de um diretório no FTP
app.get('/debug/ftp-ls', async (req, res) => {
  let client;
  try {
    const dir = req.query.dir || '.'; // ex: ?dir=imoveis  ou ?dir=public_html/imoveis
    client = await getFtpClient();
    const list = await client.list(dir);
    res.json({ dir, list });
  } catch (e) {
    res.status(500).json({ error: e?.message });
  } finally {
    if (client) client.close();
  }
});

app.get('/debug/drop-here', async (req, res) => {
  let client;
  const localTmp = '/tmp/whereami.txt';
  try {
    // cria um arquivo local com timestamp
    fs.writeFileSync(localTmp, `hello from API @ ${new Date().toISOString()}\n`, 'utf8');

    client = await getFtpClient();
    // sobe no diretório atual do login
    await client.uploadFrom(localTmp, 'whereami.txt');

    res.json({ ok: true, note: 'Procure whereami.txt via seu cliente FTP e veja em qual pasta ele caiu.' });
  } catch (e) {
    res.status(500).json({ error: e?.message });
  } finally {
    try { fs.unlinkSync(localTmp); } catch {}
    if (client) client.close();
  }
});

app.get('/debug/whereami', async (req, res) => {
  let client;
  try {
    client = await getFtpClient();
    const pwd = await client.pwd(); // diretório atual após login

    async function safeList(dir) {
      try {
        const items = await client.list(dir);
        return items.map(i => ({ name: i.name, type: i.isDirectory ? 'dir' : 'file' }));
      } catch (e) {
        return `ERR: ${e.code || e.message}`;
      }
    }

    const tries = {
      '.': await safeList('.'),
      '/': await safeList('/'),
      'public_html': await safeList('public_html'),
      'www': await safeList('www'),
      'imoveis': await safeList('imoveis'),
      'public_html/imoveis': await safeList('public_html/imoveis'),
      'www/imoveis': await safeList('www/imoveis'),
    };

    res.json({ pwd, tries });
  } catch (e) {
    res.status(500).json({ error: e?.message });
  } finally {
    if (client) client.close();
  }
});

// Tenta baixar o REMOTE_DB e mostra infos do arquivo
app.get('/debug/db', async (req, res) => {
  let client;
  try {
    client = await getFtpClient();
    await client.downloadTo(TMP_DB, REMOTE_DB);
    const raw = fs.readFileSync(TMP_DB, 'utf8');
    res.json({
      REMOTE_DB,
      size: raw.length,
      head: raw.slice(0, 200) // prévia
    });
  } catch (e) {
    res.status(500).json({ REMOTE_DB, error: e?.message });
  } finally {
    if (client) client.close();
    try { fs.unlinkSync(TMP_DB); } catch {}
  }
});

/* =========================
   Inicialização
   ========================= */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor backend rodando na porta ${PORT}`);
});
