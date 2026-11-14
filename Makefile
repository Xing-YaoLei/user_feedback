.PHONY: test demo

test:
	python3 run_tests.py -v

demo:
	python3 demo.py /tmp/audit-demo
