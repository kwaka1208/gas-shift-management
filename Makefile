# 変数の定義を読み込み
COMMAND=clasp
DEPLOY_ID=AKfycbxMSxPCW7FiaQi7vs20EAfrIQ_M83EyHjGyu_3SCKYTB3qDPzTA0UnFhQD-dckI9hvt

# 認証
login:
	$(COMMAND) login

# スクリプトをクラウドに反映
push:
	$(COMMAND) push

# クラウドのスクリプトをローカルに取り込み
pull:
	$(COMMAND) pull

# スクリプトを開く
open:
	$(COMMAND) open-script

# コンテナを開く
container:
	$(COMMAND) open-container

# webアプリを開く
app:
	$(COMMAND) open-web-app $(DEPLOY_ID)

#新しいデプロイを作成
create-deploy:
	$(if $(d),,$(error "エラー: 引数 d が指定されていません。例: make create-deploy d=explanation"))
	$(COMMAND) deploy --description	"$(d)"

# デプロイを更新
deploy:
	$(if $(d),,$(error "エラー: 引数 d が指定されていません。例: make deploy d=explanation"))
	$(COMMAND) deploy --deploymentId $(DEPLOY_ID) \
		--description "$(d)"

# バージョン情報を書き換えてリリース
release:
	$(COMMAND) push
	$(COMMAND) deploy --deploymentId $(DEPLOY_ID)
