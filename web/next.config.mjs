/** @type {import('next').NextConfig} */

// STATIC EXPORT — this is what was missing.
//
// The gh-pages branch had a commit titled "deploy: Reward Hub static export" but contained
// only .nojekyll, and the site 404s: without `output: 'export'` a Next build produces a SERVER
// build, so there was no `out/` directory to publish. GitHub reported the Pages build as
// successful because it successfully published nothing.
//
// basePath/assetPrefix are needed because Pages serves this from a repo subpath, not the
// domain root. When it moves to megapot.hence.markets these become '' — see deploy notes.
const repo = 'megapot-fee-accrual';
const isPages = process.env.DEPLOY_TARGET === 'pages';

export default {
  reactStrictMode: true,
  swcMinify: false,
  output: 'export',
  // trailing slashes keep directory-style URLs working on a static host
  trailingSlash: true,
  basePath: isPages ? `/${repo}` : '',
  assetPrefix: isPages ? `/${repo}/` : '',
  images: { unoptimized: true },   // no Next image server on a static host
};
