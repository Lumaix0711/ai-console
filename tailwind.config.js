/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./public/**/*.{html,js}'],
  // 注意：Tailwind v4 是 CSS-first 配置，主题在 src/input.css 的 @theme 里，
  // 这里只告诉它"去这些文件里找用到的类名"。
}
