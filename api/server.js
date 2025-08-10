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

const upload = multer({ dest: 'uploads/' });

const dataPath = path.join(__dirname, 'dados.json');
const readDb = () => (fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath, 'utf8')) : []);
const writeDb = (db) => fs.writeFileSync(dataPath, JSON.stringify(db, null, 2), 'utf8');

/* ---------- LISTAR ---------- */
app.get('/api/imoveis', (req, res) => {
  res.json(readDb());
});

/* ---------- SEU POST (inalterado) ---------- */
app.post('/api/upload-imovel', upload.array('images'), async (req, res) => {
  const { kind, type, title, location, price, area, dorm, parking, bath, details } = req.body;
  const images = req.files;

  let db = readDb();
  const newId = db.length > 0 ? Math.max(...db.map(i => i.id)) + 1 : 1;

  const client = new ftp.Client();
  try {
    await client.access({
      host: "ftp.henriqueluzconsultor.com.br",
      user: "henriqueluzconsultor",
      password: "00Cadluz",
      secure: false
    });

    const uploadedImages = [];
    let ordem = 1;

    for (const file of images) {
      const ext = path.extname(file.originalname).toLowerCase();
      const ftpFilename = `${newId}img${ordem}${ext}`;
      await client.uploadFrom(file.path, `imoveis/${ftpFilename}`);
      uploadedImages.push(ftpFilename);
      fs.unlinkSync(file.path);
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
      details: JSON.parse(details || "[]"),
      images: uploadedImages
    };

    db.push(newImovel);
    writeDb(db);

    res.json({ message: "Imóvel salvo com sucesso!", id: newId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro no envio por FTP" });
  } finally {
    client.close();
  }
});

/* ---------- PUT: editar e (opcionalmente) trocar imagens ---------- */
app.put('/api/imoveis/:id', upload.array('images'), async (req, res) => {
  const id = Number(req.params.id);
  // Campos textuais podem vir de form-data; tratar string/array:
  const { kind, type, title, location, price, area, dorm, parking, bath } = req.body;
  let details = req.body.details;

  const db = readDb();
  const idx = db.findIndex(i => i.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Imóvel não encontrado' });

  // Atualiza campos textuais
  const current = db[idx];
  const normalizedDetails =
    typeof details === 'string'
      ? (() => { try { return JSON.parse(details); } catch { return details; } })()
      : details;

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
    ...(normalizedDetails !== undefined ? { details: normalizedDetails } : {})
  };

  // Se o usuário enviou novas imagens, substitui no FTP
  const newFiles = req.files || [];
  if (newFiles.length > 0) {
    const client = new ftp.Client();
    try {
      await client.access({
        host: "ftp.henriqueluzconsultor.com.br",
        user: "henriqueluzconsultor",
        password: "00Cadluz",
        secure: false
      });

      // apaga antigas
      if (Array.isArray(current.images)) {
        for (const img of current.images) {
          try {
            await client.remove(`imoveis/${img}`);
          } catch (e) {
            console.warn('Falha ao remover do FTP:', img, e?.message);
          }
        }
      }

      // sobe novas com {id}img{ordem}{ext}
      const uploadedImages = [];
      let ordem = 1;
      for (const file of newFiles) {
        const ext = path.extname(file.originalname).toLowerCase();
        const ftpFilename = `${id}img${ordem}${ext}`;
        await client.uploadFrom(file.path, `imoveis/${ftpFilename}`);
        uploadedImages.push(ftpFilename);
        fs.unlinkSync(file.path);
        ordem++;
      }

      db[idx].images = uploadedImages;
    } catch (e) {
      console.error('Erro no FTP durante PUT:', e);
      return res.status(500).json({ error: 'Erro ao atualizar imagens no FTP' });
    }
  }

  writeDb(db);
  return res.json(db[idx]);
});

/* ---------- DELETE ---------- */
app.delete('/api/imoveis/:id', async (req, res) => {
  const id = Number(req.params.id);
  const db = readDb();
  const idx = db.findIndex(i => i.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Imóvel não encontrado' });

  const item = db[idx];

  try {
    const client = new ftp.Client();
    await client.access({
      host: "ftp.henriqueluzconsultor.com.br",
      user: "henriqueluzconsultor",
      password: "00Cadluz",
      secure: false
    });

    if (Array.isArray(item.images)) {
      for (const img of item.images) {
        try { await client.remove(`imoveis/${img}`); }
        catch (e) { console.warn('Falha ao remover no FTP:', img, e?.message); }
      }
    }
    client.close();
  } catch (e) {
    console.warn('Não foi possível apagar imagens no FTP. Continuando exclusão do JSON.');
  }

  db.splice(idx, 1);
  writeDb(db);
  res.json({ ok: true });
});

app.listen(3001, () => {
  console.log("Servidor backend rodando na porta 3001");
});
