import { listComics, getComic, getChapter, CATEGORIES } from '../src/site/twmanga.ts';

const line = (s = '') => console.log(s);
const head = (s: string) => {
  line();
  line('='.repeat(56));
  line('  ' + s);
  line('='.repeat(56));
};

async function main() {
  let fail = 0;
  const check = (ok: boolean, msg: string) => {
    console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${msg}`);
    if (!ok) fail++;
  };

  head('1. Search');
  try {
    const comics = await listComics({ query: '炎火' });
    check(comics.length > 0, `returned ${comics.length} comics (site ref: 352)`);
    comics.slice(0, 5).forEach((c) => {
      console.log(`      - ${c.title}`);
      console.log(`        slug   = ${c.slug}`);
      console.log(`        cover  = ${c.cover.slice(0, 68)}`);
      if (c.latestChapter) console.log(`        latest = ${c.latestChapter}`);
    });
    const withCover = comics.filter((c) => c.cover).length;
    check(withCover > comics.length * 0.8, `${withCover}/${comics.length} have cover`);
    check(
      comics.every((c) => /^[a-z0-9-]+$/.test(c.slug)),
      'all slugs are URL-safe',
    );
  } catch (e) {
    check(false, 'search failed: ' + (e as Error).message);
  }

  head('2. Category filter (xuanhuan + cn)');
  try {
    const list = await listComics({ type: 'xuanhuan', region: 'cn' });
    check(list.length > 0, `returned ${list.length} comics`);
    list.slice(0, 3).forEach((c) => console.log(`      - ${c.title}`));
  } catch (e) {
    check(false, 'category failed: ' + (e as Error).message);
  }
  check(CATEGORIES.type.length >= 17, `${CATEGORIES.type.length} genre filters`);

  head('3. Comic detail + chapter list');
  const SLUG = 'dingjiqiyunqiaoqiaoxiulianqiannian-yuewenmanhua';
  let chapterId = '';
  try {
    const { comic, chapters } = await getComic(SLUG);
    console.log(`      title  = ${comic.title}`);
    console.log(`      cover  = ${comic.cover.slice(0, 68)}`);
    if (comic.tags?.length) console.log(`      tags   = ${comic.tags.join(', ')}`);
    if (comic.description) console.log(`      desc   = ${comic.description.slice(0, 90)}`);
    check(comic.title.length > 1, `title parsed: ${comic.title}`);
    check(!!comic.cover, 'cover parsed');
    check(chapters.length > 0, `${chapters.length} chapters (site ref: 296)`);
    console.log('      first 3:');
    chapters.slice(0, 3).forEach((c) => console.log(`        ${c.id}  ${c.title}`));
    console.log('      last 3:');
    chapters.slice(-3).forEach((c) => console.log(`        ${c.id}  ${c.title}`));
    check(
      chapters.every((c, i) => i === 0 || c.index >= chapters[i - 1].index),
      'chapters sorted ascending',
    );
    check(
      chapters.every((c) => c.url.includes('/comic/chapter/')),
      'chapter URLs well-formed',
    );
    chapterId = chapters[chapters.length - 1].id;
  } catch (e) {
    check(false, 'detail failed: ' + (e as Error).message);
  }

  if (chapterId) {
    head(`4. Chapter images (${chapterId}, site ref: 50/page, 4 pages)`);
    try {
      const t0 = Date.now();
      const page = await getChapter(SLUG, chapterId);
      check(page.images.length > 0, `${page.images.length} images in ${Date.now() - t0}ms`);
      console.log(`      totalPages = ${page.totalPages}`);
      page.images.slice(0, 3).forEach((u) => console.log(`      - ${u.slice(0, 84)}`));
      check(
        page.images.every((u) => /^https:\/\//.test(u)),
        'all image URLs absolute',
      );
      check(
        page.images.every((u) => !u.includes('default_cover')),
        'no placeholder covers mixed in',
      );
      check(
        page.images.every((u) => /\.(jpg|jpeg|png|webp)$/i.test(u)),
        'all URLs end with image extension',
      );
      check(
        new Set(page.images).size === page.images.length,
        'all images unique (deduped)',
      );
      if (page.images[0]) {
        const res = await fetch(page.images[0], { method: 'HEAD' });
        check(res.ok, `first image downloadable: HTTP ${res.status} ${res.headers.get('content-type')}`);
      }
    } catch (e) {
      check(false, 'chapter fetch failed: ' + (e as Error).message);
    }
  }

  line();
  line('='.repeat(56));
  console.log(fail === 0 ? '  ALL PASS - site adapter works' : `  ${fail} FAILURES`);
  line('='.repeat(56));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('probe crashed:', e);
  process.exit(1);
});
