# line_ai_rebot
line_ai_rebot

1. LINE
https://developers.line.biz/console/channel/1622642049/messaging-api

Webhook URL  :   https://80db-218-35-143-147.ngrok-free.app/webhook
並取得 Channel access token，放入env
------------------------------------------------------------------------------
https://developers.line.biz/console/channel/1622642049
取得  Channel secret
放入env

2.ngrok
https://ngrok.com/download/windows?tab=download
3. powershell: ollama serve

4. 開server
cd C:\ngrok
.\ngrok http 3000

node server.js

5. ALLOWED_USER_ID 要在server.js抓取  USER: 回傳的白名單