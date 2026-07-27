const html = $input.first().json.body.html;
const buffer = Buffer.from(html, 'utf8');
const binaryData = await this.helpers.prepareBinaryData(buffer, 'index.html', 'text/html');
return [{ json: {}, binary: { data: binaryData } }];
