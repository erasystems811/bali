const body = $input.first().json.body;
const buffer = Buffer.from(body.pdfBase64, 'base64');
const binaryData = await this.helpers.prepareBinaryData(buffer, body.filename || 'file.pdf', 'application/pdf');
return [{ json: {}, binary: { data: binaryData } }];
