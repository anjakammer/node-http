.PHONY : purge-preview purge-jobs

purge-preview:
	kubectl delete pods,deployments,services,ingresses -n preview --all

purge-jobs:
	kubectl delete pod -n anya -l 'component in (job, build)'
