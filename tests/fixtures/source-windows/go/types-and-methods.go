package windows

type JobQueue struct {
	jobs []string
}

func NewJobQueue(initial ...string) *JobQueue {
	return &JobQueue{jobs: append([]string(nil), initial...)}
}

func (queue *JobQueue) Enqueue(job string) {
	queue.jobs = append(queue.jobs, job)
}

func (queue *JobQueue) Peek() (string, bool) {
	if len(queue.jobs) == 0 {
		return "", false
	}
	return queue.jobs[0], true
}

func (queue *JobQueue) Drain(limit int) []string {
	if limit > len(queue.jobs) {
		limit = len(queue.jobs)
	}
	selected := append([]string(nil), queue.jobs[:limit]...)
	queue.jobs = queue.jobs[limit:]
	return selected
}
