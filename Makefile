# Monorepo entry points. Each submodule owns its own `make check`.
.PHONY: check e2e

check:
	@for d in backend frontend; do \
		if [ -f $$d/Makefile ]; then $(MAKE) -C $$d check || exit 1; \
		else echo "skip: $$d/Makefile not found"; fi; \
	done

e2e:
	cd e2e && npx playwright test $(ARGS)
