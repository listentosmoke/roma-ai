# リアル音声識別

Roma は、明示的な同意を得た短時間の音声登録、本人照合、候補者識別を実装しています。音声の類似度は会話上のエンティティ解決に使う確率的な証拠であり、認証、本人確認、ライブネス証明、権限付与ではありません。顔認識、隠れた登録、連続録音は実装していません。

## 構成

ブラウザーの 16 kHz・モノラル・PCM16 は従来どおり Deepgram に転送されます。明示的な操作中だけ同じフレームをサーバー上の有界バッファへコピーし、VAD・無音・クリッピング・重なり・Roma 再生を検査して、ローカルの `Xenova/wavlm-base-plus-sv` で 512 次元の話者埋め込みを抽出します。登録時は AES-256-GCM で SQLite の `voice_templates` に暗号化保存し、照合時は同一テナントの最大 12 候補だけを比較します。結果は直接 personId にせず、既存 Entity Resolver の `voice_match` 証拠を経由します。

## 音声・同意・保管

- 最低有効発話 2.5 秒、最大 12 秒、最大 384,000 バイト、60 秒で失効
- workspace / user / session / interaction / speaker / person / purpose / operation ID / 256-bit token で分離
- キャンセル、失敗、処理完了後に PCM を削除・ゼロ化
- raw PCM、埋め込み、暗号文、鍵をブラウザー、localStorage、ログ、モデル文脈へ送らない
- 周囲の会話、名前だけの発話、文字起こし、diarization、モデル提案から自動登録しない
- `voice_identity` の有効な同意と既存 person が必須

People パネルの **Enroll Voice (I consent)** が通常の入口です。Roma の発話・TTS 再生、重複話者、短い音声、無音主体、クリッピング、低品質を拒否します。直近音声の完全一致は `possible_replay` としますが、これはライブネス検出ではありません。

## 暗号化と判定

`BIOMETRIC_ENCRYPTION_KEY` に 32 バイト base64 または 64 文字 hex の鍵を設定します。既定鍵はなく、未設定時は fail-closed です。書き込みごとに 96-bit nonce を生成し、workspace、person、profile、provider、model、version を AAD で認証します。鍵バージョンと手動再暗号化はありますが、自動ローテーションは主張しません。

閾値は strong 0.86、candidate 0.80、ambiguity margin 0.04、minimum quality 0.55、最大候補 12 です。スコアは cosine similarity で確率ではありません。記録済み会話では Dan の別区間が 0.9722、Dan と Vanessa が 0.4940 でした。一方、別の Dan 区間では 0.5709 の false rejection もあり、少数サンプルから精度を過大評価できません。

## 取消・削除・運用境界

同意取消はテンプレートを即時 `revoked` にし、候補から除外し、音声由来のセッション継続を無効化します。削除は暗号化テンプレートと参照を物理削除し、person と通常メモリーは保持します。モデル不一致は比較せず `requires_reenrollment` にします。

現在の開発認証では生体操作は loopback のみです。`AUTH_MODE=production` は実際の `verifyToken` がない限り fail-closed です。本番には TLS、実認証、秘密管理・鍵ローテーション、バックアップ削除方針、共有 rate limit、十分な校正が必要です。

## 検証

- `test/voice-identity.test.js`: 26/26
- `npm run simulate:voice-identity`: 実音声 fixture、実 WavLM、暗号化 SQLite、Entity Resolver、Context Compiler を通して 33/33
- ブラウザーで provider/key ready、マイク開始・停止、console error 0
- 実 Groq は安全な Matt・証拠 ID・関連メモリーだけを受け、正しく応答
- 物理マイクへのアクセスは成功したが管理された登録話者がいなかったため、物理マイクでの認識精度は未検証

詳細は英語版 [VOICE-IDENTITY.md](VOICE-IDENTITY.md) を参照してください。

