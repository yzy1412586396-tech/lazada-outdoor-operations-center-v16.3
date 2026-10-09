const fs=require('fs'),path=require('path');
const {Resvg}=require('@resvg/resvg-js');
const root=path.resolve(__dirname,'..');
const template=fs.readFileSync(path.join(root,'app/icons/application-icon.svg'),'utf8');
const original=fs.readFileSync(path.join(root,'app/logo.png'));
const svg=template.replace('../logo.png','data:image/png;base64,'+original.toString('base64'));
const renderer=new Resvg(svg);
fs.writeFileSync(path.join(root,'app/app-icon.png'),renderer.render().asPng());
console.log('Native app silhouette generated from SVG; source artwork bytes unchanged.');
