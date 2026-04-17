/**
 * Unit tests for Job, JobList, JobLog.
 */

import { describe, it, expect } from 'bun:test';
import { Job } from '../../src/objects/jobs/Job.js';
import { JobList } from '../../src/objects/jobs/JobList.js';
import { JobLog } from '../../src/objects/jobs/JobLog.js';

function mockSystem() {
  return {
    user: 'TESTUSER',
    password: 'TESTPASS',
    host: '127.0.0.1',
    getPasswordLevel: () => 0,
    getServerCCSID: () => 37,
    connectService: () => { throw new Error('mock: not connected'); },
  };
}

describe('Job', () => {
  it('requires an AS400 instance', () => {
    expect(() => new Job(null)).toThrow('requires an AS400 instance');
  });

  it('constructs with defaults', () => {
    const job = new Job(mockSystem());
    expect(job.getName()).toBe('*');
    expect(job.getUser()).toBe('*');
    expect(job.getNumber()).toBe('');
    expect(job.getStatus()).toBe('');
    expect(job.getType()).toBe('');
    expect(job.getCPUUsed()).toBe(0);
    expect(job.getRunPriority()).toBe(0);
    expect(job.getSubsystem()).toBe('');
  });

  it('constructs with values', () => {
    const job = new Job(mockSystem(), 'MYUSER', 'MYJOB', '123456');
    expect(job.getName()).toBe('MYJOB');
    expect(job.getUser()).toBe('MYUSER');
    expect(job.getNumber()).toBe('123456');
  });

  it('toString formats correctly', () => {
    const job = new Job(mockSystem(), 'MYUSER', 'MYJOB', '123456');
    expect(job.toString()).toBe('123456/MYUSER/MYJOB');
  });

  it('loadInformation throws without connection', async () => {
    const job = new Job(mockSystem());
    await expect(job.loadInformation()).rejects.toThrow();
  });

  it('getInfo returns a copy', () => {
    const job = new Job(mockSystem());
    const info = job.getInfo();
    expect(typeof info).toBe('object');
    info.test = 'mutated';
    expect(job.getInfo().test).toBeUndefined();
  });
});

describe('JobList', () => {
  it('requires an AS400 instance', () => {
    expect(() => new JobList(null)).toThrow('requires an AS400 instance');
  });

  it('constructs and supports criteria', () => {
    const jl = new JobList(mockSystem());
    jl.addJobSelectionCriteria(JobList.SELECTION_JOB_NAME, 'QPADEV*');
    expect(jl).toBeDefined();
  });

  it('has selection constants', () => {
    expect(JobList.SELECTION_JOB_NAME).toBe('jobName');
    expect(JobList.SELECTION_USER_NAME).toBe('userName');
    expect(JobList.SELECTION_JOB_NUMBER).toBe('jobNumber');
    expect(JobList.SELECTION_JOB_TYPE).toBe('jobType');
    expect(JobList.SELECTION_ACTIVE_STATUS).toBe('activeStatus');
  });
});

describe('JobLog', () => {
  it('requires an AS400 instance', () => {
    expect(() => new JobLog(null)).toThrow('requires an AS400 instance');
  });

  it('constructs with defaults', () => {
    const jl = new JobLog(mockSystem());
    expect(jl).toBeDefined();
  });

  it('constructs with job identification', () => {
    const jl = new JobLog(mockSystem(), 'MYJOB', 'MYUSER', '123456');
    expect(jl).toBeDefined();
  });
});
