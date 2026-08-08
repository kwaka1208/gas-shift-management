# clasp 操作。展開先のコンテナは targets.mk に定義する。
#
#   make release          … 全コンテナへ push してデプロイを更新
#   make release t=main   … main だけへ
#   make targets          … 定義済みのコンテナ一覧
#
# push / deploy / release / create-deploy は t を省くと全コンテナが対象。
# pull / open / container / app / status は1つだけが対象で、コンテナが
# 複数あるときは t の指定が要る。

COMMAND   := clasp
CLASP_DIR := .clasp.d

include targets.mk

.DEFAULT_GOAL := help

# --- コンテナの解決 ---------------------------------------------------------
# これらは必ずレシピの中で展開する。前提条件（:の右）に書くと、無関係な
# make を叩いたときにも $(error) が発火してしまう。

# targets.mk に無い名前を弾く
check_ = $(if $(filter $(1),$(TARGETS)),$(1),$(error 未定義のコンテナです: $(1)（定義済み: $(TARGETS)）))

# 全コンテナへ展開する操作。t を省くと全部。
EACH = $(if $(t),$(call check_,$(t)),$(TARGETS))

# 1つだけを相手にする操作。t を省いたとき、コンテナが1つならそれを使う。
ONE = $(if $(t),$(call check_,$(t)),$(if $(word 2,$(TARGETS)),$(error 対象のコンテナを指定してください。例: t=$(firstword $(TARGETS))（定義済み: $(TARGETS)）),$(TARGETS)))

# デプロイIDの書き忘れは push の後に気付くと面倒なので、先に止める
need_deploy_id = $(if $(DEPLOY_ID_$(1)),,$(error DEPLOY_ID_$(1) が targets.mk にありません))

CLASP = $(COMMAND) -P $(CLASP_DIR)/$(1).json

PROJECTS := $(foreach n,$(TARGETS),$(CLASP_DIR)/$(n).json)

# clasp のプロジェクトファイルは targets.mk から生成する（Git管理しない）。
# rootDir が ".." なので、push 対象はリポジトリ直下のファイルになる。
$(CLASP_DIR)/%.json: targets.mk
	@$(if $(SCRIPT_ID_$*),,$(error SCRIPT_ID_$* が targets.mk にありません))
	@mkdir -p $(@D)
	@printf '{\n  "scriptId": "%s",\n  "rootDir": "..",\n  "scriptExtensions": [".js", ".gs"],\n  "htmlExtensions": [".html"],\n  "jsonExtensions": [".json"],\n  "filePushOrder": [],\n  "skipSubdirectories": false\n}\n' '$(SCRIPT_ID_$*)' > $@

# --- 認証 -------------------------------------------------------------------

login:
	$(COMMAND) login

# --- 全コンテナへ展開する操作 -------------------------------------------------

# スクリプトをクラウドに反映
push: | $(PROJECTS)
	@for n in $(EACH); do $(MAKE) --no-print-directory _push t=$$n || exit 1; done

_push:
	@echo "==> [$(ONE)] $(NAME_$(ONE)) へ push"
	@$(call CLASP,$(ONE)) push

# デプロイを更新（URLは変わらない）
deploy: | $(PROJECTS)
	$(if $(d),,$(error エラー: 引数 d が指定されていません。例: make deploy d=explanation))
	@for n in $(EACH); do $(MAKE) --no-print-directory _deploy t=$$n d='$(d)' || exit 1; done

_deploy:
	@$(call need_deploy_id,$(ONE))
	@echo "==> [$(ONE)] $(NAME_$(ONE)) のデプロイを更新"
	@$(call CLASP,$(ONE)) deploy --deploymentId $(DEPLOY_ID_$(ONE)) --description "$(d)"

# 新しいデプロイを作成（URLが変わる。作ったら targets.mk の DEPLOY_ID を書き換えること）
create-deploy: | $(PROJECTS)
	$(if $(d),,$(error エラー: 引数 d が指定されていません。例: make create-deploy d=explanation))
	@for n in $(EACH); do $(MAKE) --no-print-directory _create-deploy t=$$n d='$(d)' || exit 1; done

_create-deploy:
	@echo "==> [$(ONE)] $(NAME_$(ONE)) に新しいデプロイを作成"
	@$(call CLASP,$(ONE)) deploy --description "$(d)"

# push してデプロイを更新
release: | $(PROJECTS)
	@for n in $(EACH); do $(MAKE) --no-print-directory _release t=$$n || exit 1; done

_release:
	@$(call need_deploy_id,$(ONE))
	@echo "==> [$(ONE)] $(NAME_$(ONE)) へリリース"
	@$(call CLASP,$(ONE)) push
	@$(call CLASP,$(ONE)) deploy --deploymentId $(DEPLOY_ID_$(ONE))

# --- 1つのコンテナだけを相手にする操作 -----------------------------------------

# クラウドのスクリプトをローカルに取り込み
pull: | $(PROJECTS)
	@echo "==> [$(ONE)] $(NAME_$(ONE)) から pull"
	@$(call CLASP,$(ONE)) pull

# push される予定のファイルを確認する
status: | $(PROJECTS)
	@echo "==> [$(ONE)] $(NAME_$(ONE))"
	@$(call CLASP,$(ONE)) status

# スクリプトを開く
open: | $(PROJECTS)
	@$(call CLASP,$(ONE)) open-script

# コンテナ（スプレッドシート）を開く
container: | $(PROJECTS)
	@$(call CLASP,$(ONE)) open-container

# webアプリを開く
app: | $(PROJECTS)
	@$(call need_deploy_id,$(ONE))
	@$(call CLASP,$(ONE)) open-web-app $(DEPLOY_ID_$(ONE))

# --- 情報表示 ---------------------------------------------------------------

# 定義済みのコンテナ一覧
targets:
	@echo "定義済みのコンテナ（targets.mk）"
	@$(foreach n,$(TARGETS),echo "  $(n)  $(NAME_$(n))"; echo "    script:  $(SCRIPT_ID_$(n))"; echo "    deploy:  $(DEPLOY_ID_$(n))";)

help:
	@echo "使い方: make <コマンド> [t=<コンテナ名>]"
	@echo ""
	@echo "  全コンテナが対象（t で1つに絞れる）"
	@echo "    push            スクリプトをクラウドに反映"
	@echo "    release         push してデプロイを更新"
	@echo "    deploy d=説明   デプロイを更新（URLは変わらない）"
	@echo "    create-deploy d=説明  新しいデプロイを作成（URLが変わる）"
	@echo ""
	@echo "  1つのコンテナが対象（複数あるときは t が要る）"
	@echo "    pull            クラウドのスクリプトを取り込み"
	@echo "    status          push される予定のファイルを確認"
	@echo "    open            スクリプトエディタを開く"
	@echo "    container       スプレッドシートを開く"
	@echo "    app             webアプリを開く"
	@echo ""
	@echo "  その他"
	@echo "    login           claspの認証"
	@echo "    targets         定義済みのコンテナ一覧"
	@echo ""
	@echo "  定義済みのコンテナ: $(TARGETS)"

.PHONY: login push _push deploy _deploy create-deploy _create-deploy \
        release _release pull status open container app targets help
