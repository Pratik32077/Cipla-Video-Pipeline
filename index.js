const express      = require('express');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const { execSync } = require('child_process');
const ffmpegPath   = require('ffmpeg-static');  // bundled FFmpeg binary

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── On Vercel, only /tmp is writable. Locally, use project folders. ──────────
const TMP        = '/tmp';
const INTRO      = path.join(__dirname, 'intro.mp4');
const OUTRO      = path.join(__dirname, 'outro.mp4');

// multer stores uploads in /tmp
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP),
  filename:    (req, file, cb) => cb(null, `upload_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

// ── helpers ───────────────────────────────────────────────────────────────────

function ffmpeg(cmd) {
  // Use bundled ffmpeg-static binary so it works on Vercel with no install
  execSync(`"${ffmpegPath}" ${cmd}`, { stdio: 'inherit' });
}

function normalize(inputPath, outputPath) {
  ffmpeg(
    `-y -i "${inputPath}" ` +
    `-vf "scale=1280:720:force_original_aspect_ratio=decrease,` +
    `pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30" ` +
    `-c:v libx264 -preset fast -crf 23 ` +
    `-c:a aac -b:a 128k -ar 44100 -ac 2 ` +
    `"${outputPath}"`
  );
}

function addTextOverlay(inputPath, outputPath, name, specialization, city) {
  const escape = str => str
    .replace(/\\/g, '\\\\')
    .replace(/'/g,  '\u2019')
    .replace(/:/g,  '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');

  const text = `Dr ${escape(name)} | ${escape(specialization)} | ${escape(city)}`;

  const drawtext =
    `drawtext=text='${text}':` +
    `fontsize=32:fontcolor=white:` +
    `box=1:boxcolor=black@0.6:boxborderw=10:` +
    `x=(w-text_w)/2:y=50`;

  ffmpeg(
    `-y -i "${inputPath}" -vf "${drawtext}" ` +
    `-c:v libx264 -preset fast -crf 23 ` +
    `-c:a aac -b:a 128k -ar 44100 -ac 2 ` +
    `"${outputPath}"`
  );
}

// ── routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const name           = (req.body.name           || '').trim();
  const specialization = (req.body.specialization || '').trim();
  const city           = (req.body.city           || '').trim();

  const ts            = Date.now();
  const uploadedRaw   = req.file.path;
  const normIntro     = path.join(TMP, `intro_${ts}.mp4`);
  const normUser      = path.join(TMP, `user_${ts}.mp4`);
  const processedUser = path.join(TMP, `processed_${ts}.mp4`);
  const normOutro     = path.join(TMP, `outro_${ts}.mp4`);
  const outputFile    = path.join(TMP, `merged_${ts}.mp4`);
  const filelistPath  = path.join(TMP, `filelist_${ts}.txt`);

  try {
    console.log('Normalizing intro…');    normalize(INTRO,       normIntro);
    console.log('Normalizing upload…');   normalize(uploadedRaw, normUser);
    console.log('Normalizing outro…');    normalize(OUTRO,       normOutro);

    if (name && specialization && city) {
      console.log('Adding text overlay…');
      addTextOverlay(normUser, processedUser, name, specialization, city);
    } else {
      fs.copyFileSync(normUser, processedUser);
    }

    fs.writeFileSync(filelistPath, [
      `file '${normIntro}'`,
      `file '${processedUser}'`,
      `file '${normOutro}'`
    ].join('\n'));

    console.log('Concatenating…');
    ffmpeg(`-y -f concat -safe 0 -i "${filelistPath}" -c copy "${outputFile}"`);

    // Clean up temp files (keep output)
    [normIntro, normUser, processedUser, normOutro, filelistPath, uploadedRaw]
      .forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });

    // Stream the final video back directly — no static /outputs folder needed
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="merged_${ts}.mp4"`);
    const stream = fs.createReadStream(outputFile);
    stream.pipe(res);
    stream.on('end', () => {
      try { fs.unlinkSync(outputFile); } catch (_) {}
    });

  } catch (err) {
    console.error('Processing error:', err.message);
    res.status(500).json({ error: 'FFmpeg failed: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

module.exports = app; // needed for Vercel
