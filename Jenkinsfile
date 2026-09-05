// =====================================================================
// Air-gapped dsh-aio dev image chain, built on 10.1.17.58 (no public
// egress). The Jenkins job (new-jenkins.jereh.cn, "dsh-aio-dev-build") is
// configured as Pipeline script from SCM against this repository's master
// branch with the `bitbucket` credential; this file is the only pipeline
// source.
//
// Flow: checkout -> tar-over-ssh sync to /opt/dsh-aio-build -> remote
// docker/build-dsh-aio-dev-amd64-internal.sh -> verify. Every external
// source (harbor base images, Nexus npm + raw apt proxies, MinIO jcli and
// chrome objects) is injected via the .internal Dockerfiles' build args,
// whose defaults are the internal mirrors; see
// .agents/notes/implemented/process/2026-09-05-airgapped-dsh-aio-build-chain.md
//
// PUSH_HARBOR=true additionally tags and pushes dsh:dev-amd64 and
// dsh-aio:dev-amd64[-<sha>] to harbor.jereh.cn/base using the docker login
// already present in admin's ~/.docker/config.json on the target host.
// =====================================================================
pipeline {
  agent { label 'jenkins1 || jenkins2' }
  parameters {
    string(name: 'TARGET_HOST', defaultValue: '10.1.17.58', description: 'air-gapped build host (ssh user admin)')
    booleanParam(name: 'PUSH_HARBOR', defaultValue: false, description: 'push built images to harbor.jereh.cn/base')
  }
  environment {
    SSH_USER = 'admin'
    REPO_DIR = '/opt/dsh-aio-build'
    INTERNAL_SCRIPT = 'docker/build-dsh-aio-dev-amd64-internal.sh'
    GIT_URL = 'https://bitbucket.jereh.cn/scm/ai/deepseek-harness.git'
    TARGET_HOST = "${params.TARGET_HOST}"
  }
  options { timestamps(); disableConcurrentBuilds(); skipDefaultCheckout() }
  stages {
    stage('Checkout') {
      steps {
        // An interrupted Sync can leave the workspace .git/config swapped;
        // when the repo is unusable, drop the workspace so checkout re-clones.
        sh '''
set -e
git rev-parse HEAD >/dev/null 2>&1 || { echo "workspace git state broken; wiping"; find . -mindepth 1 -delete; }
'''
        checkout scm
        sh 'git rev-parse --short HEAD; du -sh .git'
      }
    }
    stage('Sync source to host') {
      steps {
        sshagent(credentials: ['ssh']) {
          sh '''
set -e
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$SSH_USER@$TARGET_HOST" "mkdir -p $REPO_DIR"
# Replace the Jenkins checkout-local git config (core.hooksPath=/dev/null,
# extensions.worktreeConfig) with a plain one so the dev container carries
# usable git defaults; restore the original right after tarring.
rm -f .git/hooks/*.sample 2>/dev/null
cp .git/config .git/config.jenkins.bak
cat > .git/config <<EOF
[core]
    repositoryformatversion = 0
    filemode = true
    bare = false
[remote "origin"]
    url = $GIT_URL
    fetch = +refs/heads/*:refs/remotes/origin/*
EOF
set +e
tar czf - . | ssh -o StrictHostKeyChecking=no "$SSH_USER@$TARGET_HOST" "rm -rf $REPO_DIR.new && mkdir -p $REPO_DIR.new && tar xzf - -C $REPO_DIR.new && if [ -d $REPO_DIR ]; then mv $REPO_DIR $REPO_DIR.old; fi && mv $REPO_DIR.new $REPO_DIR && rm -rf $REPO_DIR.old"
RC=$?
mv .git/config.jenkins.bak .git/config
exit $RC
'''
        }
      }
    }
    stage('Build and optionally push on host') {
      steps {
        sshagent(credentials: ['ssh']) {
          script {
            def push = params.PUSH_HARBOR ? '1' : '0'
            sh ('set -e\n' +
              'ssh -o StrictHostKeyChecking=no "$SSH_USER@$TARGET_HOST" ' +
              '"cd $REPO_DIR && PUSH_HARBOR=' + push + ' bash $INTERNAL_SCRIPT"')
          }
        }
      }
    }
    stage('Verify images') {
      steps {
        sshagent(credentials: ['ssh']) {
          sh '''
set -e
ssh -o StrictHostKeyChecking=no "$SSH_USER@$TARGET_HOST" "docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep -E '^dsh(-aio)?:dev-amd64' | head -5"
'''
        }
      }
    }
  }
}
