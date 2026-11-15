require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------- MongoDB ----------
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
const priceSchema = new mongoose.Schema({
  productId: String,
  title: String,
  url: String,
  currentPrice: Number,
  history: [{ price: Number, date: Date }],
});
const Price = mongoose.model('Price', priceSchema);

// ---------- Helper: fetch price ----------
async function fetchPrice(productUrl) {
  const resp = await axios.get('https://api.scraperapi.com', {
    params: {
      api_key: process.env.SCRAPER_API_KEY,
      url: productUrl,
    },
  });
  const html = resp.data;

  // Naïve price extraction – first "$xx.xx"
  const priceMatch = html.match(/[$]([0-9]+(?:\.[0-9]{2})?)/);
  if (!priceMatch) throw new Error('Price not found');
  const price = parseFloat(priceMatch[1]);

  // Title from <title> tag (fallback to URL)
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : productUrl;

  return { price, title };
}

// ---------- API ----------
app.post('/api/track', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const productId = Date.now().toString();
  try {
    const { price, title } = await fetchPrice(url);
    const doc = await Price.create({
      productId,
      title,
      url,
      currentPrice: price,
      history: [{ price, date: new Date() }],
    });
    res.json(doc);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch price' });
  }
});

app.get('/api/products', async (_, res) => {
  const list = await Price.find({});
  res.json(list);
});

// ---------- Daily price check ----------
cron.schedule('0 9 * * *', async () => {
  console.log('🔄 Running daily price check...');
  const all = await Price.find({});
  for (const item of all) {
    try {
      const { price } = await fetchPrice(item.url);
      if (price !== item.currentPrice) {
        await Price.updateOne(
          { _id: item._id },
          {
            currentPrice: price,
            $push: { history: { price, date: new Date() } },
          }
        );
        console.log(`📈 Updated "${item.title}" → $${price}`);
      }
    } catch (e) {
      console.error(`❌ ${item.productId} error: ${e.message}`);
    }
  }
});

// ---------- Tiny HTML UI ----------
const html = `
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Deal‑Soldier‑Lite</title>
<style>
body{font-family:sans-serif;margin:2rem;}
input{width:80%;padding:0.5rem;}
button{padding:0.5rem 1rem;margin-left:0.5rem;}
.card{border:1px solid #ddd;padding:1rem;margin-top:1rem;border-radius:4px;}
</style></head>
<body>
<h1>Deal‑Soldier‑Lite</h1>
<input id="url" placeholder="Product page URL"/>
<button onclick="track()">Track this product</button>
<div id="list"></div>
<script>
async function load(){
  const res = await fetch('/api/products');
  const items = await res.json();
  const c=document.getElementById('list');c.innerHTML='';
  items.forEach(i=>{
    const d=document.createElement('div');d.className='card';
    d.innerHTML=\`<strong>\${i.title}</strong><br/>Current price: $\${i.currentPrice?.toFixed(2) ?? '-'}<br/><a href="\${i.url}" target="_blank">View product</a>\`;
    c.appendChild(d);
  });
}
async function track(){
  const url=document.getElementById('url').value.trim();
  if(!url) return alert('Enter a URL');
  await fetch('/api/track',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
  document.getElementById('url').value='';load();
}
load();
</script>
</body></html>
`;
app.get('/', (_, res) => res.send(html));

// ---------- Start ----------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`));
