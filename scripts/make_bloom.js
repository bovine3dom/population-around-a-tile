const { BloomFilter } = require('bloomfilter');
const fs = require('fs');
const generatedTiles = JSON.parse(fs.readFileSync('map/data/kontur_export/meta.json', 'utf8'));


// const filter = new BloomFilter(128*256, 16);
const filter = BloomFilter.withTargetError(generatedTiles.length, 0.1);

for (const tile of generatedTiles) {
  filter.add(tile);
}

fs.writeFileSync('map/data/kontur_export/bloom.json', JSON.stringify(filter));
