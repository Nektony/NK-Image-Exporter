const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const HtmlInlineScriptPlugin = require('html-inline-script-webpack-plugin');

const tsRule = {
  test: /\.ts$/,
  use: 'ts-loader',
  exclude: /node_modules/,
};

module.exports = [
  // Plugin main thread
  {
    name: 'code',
    entry: './src/code.ts',
    output: {
      filename: 'code.js',
      path: path.resolve(__dirname, 'dist'),
    },
    module: { rules: [tsRule] },
    resolve: { extensions: ['.ts', '.js'] },
  },
  // Plugin UI — compiled TS inlined into a single HTML file
  {
    name: 'ui',
    entry: './src/ui.ts',
    output: {
      filename: 'ui.js',
      path: path.resolve(__dirname, 'dist'),
    },
    module: { rules: [tsRule] },
    resolve: { extensions: ['.ts', '.js'] },
    plugins: [
      new HtmlWebpackPlugin({
        template: './src/ui.html',
        filename: 'ui.html',
        inject: 'body',
        scriptLoading: 'blocking',
      }),
      new HtmlInlineScriptPlugin(),
    ],
  },
];
